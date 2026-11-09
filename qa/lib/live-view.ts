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
 * - liveAction(page, label, target?) records what is about to happen, for the
 *   caption over the frame ("Clicking 'Log in'"), and the target's box for the
 *   highlight. The label must never contain a secret.
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

function maskOf(page: Page) {
  return [
    page.locator(
      'input[type=password], input[autocomplete="one-time-code"], input[autocomplete="current-password"], input[autocomplete="new-password"]',
    ),
  ];
}

/** A screenshot taken mid-navigation or as the page closes fails; that is normal and not worth a log line. */
class SkippedFrame extends Error {}

async function shoot(page: Page, quality: number): Promise<Buffer> {
  return page
    .screenshot({ type: "jpeg", quality, scale: "css", mask: maskOf(page), timeout: SCREENSHOT_TIMEOUT_MS })
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
  let bytes = await shoot(page, 55);
  if (bytes.byteLength > MAX_FRAME_BYTES) bytes = await shoot(page, 30);
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

export async function liveAction(page: Page, label: string, target?: Locator): Promise<void> {
  const state = states.get(page);
  if (!state || state.stopped) return;
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
