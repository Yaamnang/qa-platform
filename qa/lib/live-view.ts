/**
 * Live view: lets the console show what the QA browser sees and does.
 *
 * Every browser the system drives (Explore, the built-in Probe suite, the AI
 * Probe) calls attachLiveView(page) once and liveAction(...) before each
 * action. When the run was started from the console (the console link env vars
 * are set), frames are sent to the console's job page; otherwise both calls
 * do nothing, so `npm run qa`, CI and the bug matrix are unaffected.
 *
 * CONTRACT (keep these signatures):
 * - attachLiveView(page) starts sending a masked JPEG of the page about twice a
 *   second and after each action. Password and one-time-code inputs are always
 *   masked. Returns a function that stops it.
 * - liveAction(page, label, target?, { secret }) records what is about to
 *   happen, for the caption over the frame ("Clicking 'Log in'"), and the
 *   target's box for the highlight. The label must never contain a secret.
 *   With secret: true, or a label that says the run is typing a password or a
 *   one-time code, the target stays masked in every later frame of the page.
 *
 * Frames go to POST ${CONSOLE_JOB_URL}/frame (lib/console/contract.ts, "Live
 * view"). The console keeps only the latest one, in memory. Header values are
 * URI-encoded, so any character survives the trip. The label and URL are run
 * through the same redaction as everything else the run sends.
 */
import type { Locator, Page } from "@playwright/test";
import { secretsToRedact, redact } from "../explore/redact";
import { linked } from "./console-link";

const TICK_MS = 500;
const SEND_TIMEOUT_MS = 5000;
const SCREENSHOT_TIMEOUT_MS = 3000;
const BOX_TIMEOUT_MS = 500;
/** A highlight is only true just before and during the action. */
const BOX_TTL_MS = 2500;
/** The console refuses bigger frames (413). One retry at a lower quality first. */
const MAX_FRAME_BYTES = 600 * 1024;
const LOG_EVERY_MS = 60_000;

type Box = { x: number; y: number; width: number; height: number };

type LiveState = {
  label: string | null;
  /** Fields the run typed a secret into. Masked whatever their attributes. */
  secretTargets: Locator[];
  box: Box | null;
  boxAt: number;
  sending: boolean;
  /** A frame was asked for while one was being sent: send another right after. */
  again: boolean;
  stopped: boolean;
  kick: () => void;
  cleanup: () => void;
};

const states = new WeakMap<Page, LiveState>();
let lastLogAt = 0;

function logOnce(err: unknown) {
  const now = Date.now();
  if (now - lastLogAt < LOG_EVERY_MS) return;
  lastLogAt = now;
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[live-view] Could not send a frame: ${clean(message).split("\n")[0].slice(0, 200)}`);
}

function clean(text: string): string {
  return redact(text, secretsToRedact());
}

const header = (text: string) => encodeURIComponent(text);

/**
 * What counts as a password or one-time-code field. The one definition: the
 * explorer's sign-in (markSignInForm in qa/explore/crawl.ts) gets these rules
 * as its argument, and the live view masks every field they could match.
 * Plain strings and numbers, because markSignInForm runs inside the page.
 */
export const SECRET_FIELD_RULES = {
  /** The attribute markSignInForm puts on the fields it chose. */
  attribute: "data-explore-signin",
  passwordAutocomplete: ["current-password", "new-password"],
  codeAutocomplete: "one-time-code",
  /** inputmode=numeric with a maxlength in this range is a code field. */
  codeMinLength: 6,
  codeMaxLength: 8,
  /** A label, placeholder, aria-label or name with this word is a code field... */
  codeWord: "code",
  /** ...unless it is one of these (a regular expression source, case-insensitive). */
  notCodeSource: "(promo|coupon|zip|postal|post|country|area|discount)\\s*code|captcha",
} as const;

export type SecretFieldRules = typeof SECRET_FIELD_RULES;

/**
 * What counts as a CAPTCHA. Used by qa/lib/captcha.ts, in the page. The answer
 * to a CAPTCHA is not a secret, so the field it marks is never masked: the
 * person watching has to see the picture and what was typed.
 */
export const CAPTCHA_RULES = {
  /** The attribute the detector puts on what it found: "input", "image" or "widget". */
  attribute: "data-qa-captcha",
  /** An input whose name, id, aria-label, placeholder or label says this is a CAPTCHA answer field (regular expression source, case-insensitive). */
  fieldSource:
    "captcha|characters (shown|you see|in the (image|picture))|(text|letters|numbers|digits) (shown|you see|in the (image|picture))|type the (text|characters|letters|numbers|digits)",
  /** A third-party widget, by iframe src or title. These cannot be answered by typing. */
  widgetSource: "recaptcha|hcaptcha|challenges\\.cloudflare\\.com|turnstile|cloudflare security challenge",
  /** An invisible reCAPTCHA does not stop a person, so it does not count. */
  invisibleSource: "size=invisible",
  /** The site saying the answer was wrong. */
  errorSelector: [
    '[data-qa-captcha="input"][aria-invalid="true"]',
    '[id*="captcha" i][id*="error" i]',
    '[data-testid*="captcha" i][data-testid*="error" i]',
    '[class*="captcha" i][class*="error" i]',
  ].join(", "),
} as const;

export type CaptchaRules = typeof CAPTCHA_RULES;

/** A field the CAPTCHA detector marked. Never masked, whatever its name says. */
const NOT_CAPTCHA = `:not([${CAPTCHA_RULES.attribute}="input"])`;

/** Typing labels that always mean a secret, used by qa/lib/ui.ts and qa/explore/crawl.ts. */
const SECRET_TYPING = /^Typing the (password|one-time code)\b/i;
const MAX_SECRET_TARGETS = 20;

/**
 * A superset of the rules above as CSS, so a frame never waits on the page.
 * Masking a field that is not a secret (a promo code box) costs nothing.
 */
function secretFieldSelector(rules: SecretFieldRules): string {
  const word = rules.codeWord;
  const lengths = [];
  for (let n = rules.codeMinLength; n <= rules.codeMaxLength; n++) lengths.push(`[maxlength="${n}"]`);
  return [
    "input[type=password i]",
    ...[
      `[${rules.attribute}="password"]`,
      `[${rules.attribute}="code"]`,
      ...rules.passwordAutocomplete.map((value) => `input[autocomplete~="${value}" i]`),
      `input[autocomplete~="${rules.codeAutocomplete}" i]`,
      `input[inputmode="numeric" i]:is(${lengths.join(", ")})`,
      `input[aria-label*="${word}" i]`,
      `input[placeholder*="${word}" i]`,
      `input[name*="${word}" i]`,
    ].map((selector) => selector + NOT_CAPTCHA),
  ].join(", ");
}

const SECRET_FIELDS = secretFieldSelector(SECRET_FIELD_RULES);

function maskOf(page: Page, state?: LiveState): Locator[] {
  return [
    page.locator(SECRET_FIELDS),
    // Inputs whose <label> or aria-labelledby text has the word.
    page.locator(`input${NOT_CAPTCHA}`).and(page.getByLabel(new RegExp(SECRET_FIELD_RULES.codeWord, "i"))),
    ...(state?.secretTargets ?? []),
  ];
}

/** A screenshot taken mid-navigation or as the page closes fails; that is normal and not worth a log line. */
class SkippedFrame extends Error {}

async function shoot(page: Page, state: LiveState, quality: number): Promise<Buffer> {
  return page
    .screenshot({ type: "jpeg", quality, scale: "css", mask: maskOf(page, state), timeout: SCREENSHOT_TIMEOUT_MS })
    .catch((err: unknown) => {
      throw new SkippedFrame(err instanceof Error ? err.message : String(err));
    });
}

async function viewportOf(page: Page): Promise<{ width: number; height: number }> {
  const size = page.viewportSize();
  if (size) return size;
  return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
}

async function sendFrame(page: Page, state: LiveState): Promise<void> {
  let bytes = await shoot(page, state, 55);
  if (bytes.byteLength > MAX_FRAME_BYTES) bytes = await shoot(page, state, 30);
  if (bytes.byteLength > MAX_FRAME_BYTES) throw new SkippedFrame("frame over the size limit");
  if (state.stopped) return;

  const box = state.box && Date.now() - state.boxAt < BOX_TTL_MS ? state.box : null;
  const headers: Record<string, string> = {
    authorization: `Bearer ${process.env.CONSOLE_JOB_TOKEN}`,
    "content-type": "image/jpeg",
    "x-live-url": header(clean(page.url()).slice(0, 2000)),
    "x-live-viewport": JSON.stringify(await viewportOf(page)),
  };
  if (state.label) headers["x-live-label"] = header(state.label);
  if (box) headers["x-live-box"] = JSON.stringify(box);

  const res = await fetch(`${process.env.CONSOLE_JOB_URL}/frame`, {
    method: "POST",
    headers,
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  // The body is not needed; reading it frees the connection.
  await res.arrayBuffer().catch(() => undefined);
  if (!res.ok) throw new Error(`the console answered ${res.status}`);
}

export function attachLiveView(page: Page): () => void {
  if (!linked()) return () => {};
  const existing = states.get(page);
  if (existing && !existing.stopped) return () => stop(page, existing);

  const state: LiveState = {
    label: null,
    secretTargets: [],
    box: null,
    boxAt: 0,
    sending: false,
    again: false,
    stopped: false,
    kick: () => {},
    cleanup: () => {},
  };

  const tick = () => {
    if (state.stopped || page.isClosed()) return;
    if (state.sending) {
      state.again = true;
      return;
    }
    state.sending = true;
    state.again = false;
    sendFrame(page, state)
      .catch((err: unknown) => {
        if (!(err instanceof SkippedFrame) && !state.stopped && !page.isClosed()) logOnce(err);
      })
      .finally(() => {
        state.sending = false;
        if (state.again && !state.stopped) setImmediate(tick);
      });
  };
  state.kick = tick;

  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  const onClose = () => stop(page, state);
  page.once("close", onClose);
  state.cleanup = () => {
    clearInterval(timer);
    page.off("close", onClose);
  };
  states.set(page, state);
  tick();
  return () => stop(page, state);
}

function stop(page: Page, state: LiveState) {
  if (state.stopped) return;
  state.stopped = true;
  state.cleanup();
  if (states.get(page) === state) states.delete(page);
}

/** A visible password field or one-time-code field means the page is a sign-in step. */
const SIGN_IN_FIELDS = `input[type=password i]:visible, input[autocomplete~="${SECRET_FIELD_RULES.codeAutocomplete}" i]:visible`;
const ISSUE_QUALITY = 70;

/**
 * One picture of the page for a failed step, for the report. Same mask as the
 * live view, so every field that could hold a password or code is blacked out.
 * Returns "sign-in" without taking anything when the page is a sign-in step,
 * and null when the screenshot fails: the run carries on without an image.
 */
export async function captureIssue(page: Page): Promise<Buffer | "sign-in" | null> {
  try {
    if (page.isClosed()) return null;
    if ((await page.locator(SIGN_IN_FIELDS).count()) > 0) return "sign-in";
    return await page.screenshot({ type: "jpeg", quality: ISSUE_QUALITY, scale: "css", mask: maskOf(page, states.get(page)), timeout: SCREENSHOT_TIMEOUT_MS });
  } catch {
    return null;
  }
}

/**
 * Sends a frame of the page as it is now and waits until it has gone, so a
 * question about what is on screen is never asked ahead of the picture.
 */
export async function liveFrameNow(page: Page): Promise<void> {
  const state = states.get(page);
  if (!state || state.stopped) return;
  const deadline = Date.now() + SEND_TIMEOUT_MS + SCREENSHOT_TIMEOUT_MS;
  while (state.sending && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  state.sending = true;
  try {
    await sendFrame(page, state);
  } catch (err) {
    if (!(err instanceof SkippedFrame) && !state.stopped && !page.isClosed()) logOnce(err);
  } finally {
    state.sending = false;
  }
}

export async function liveAction(page: Page, label: string, target?: Locator, options: { secret?: boolean } = {}): Promise<void> {
  const state = states.get(page);
  if (!state || state.stopped) return;
  if (target && (options.secret ?? SECRET_TYPING.test(label))) {
    state.secretTargets.push(target);
    if (state.secretTargets.length > MAX_SECRET_TARGETS) state.secretTargets.shift();
  }
  state.label = clean(label).replace(/\s+/g, " ").trim().slice(0, 200) || null;
  state.box = null;
  if (target) {
    const box = await target.boundingBox({ timeout: BOX_TIMEOUT_MS }).catch(() => null);
    if (box && [box.x, box.y, box.width, box.height].every(Number.isFinite)) {
      state.box = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
      state.boxAt = Date.now();
    }
  }
  state.kick();
}
