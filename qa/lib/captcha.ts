import type { Locator, Page } from "@playwright/test";
import { ask, attended, linked } from "./console-link";
import { CAPTCHA_RULES, liveAction, liveFrameNow, type CaptchaRules } from "./live-view";

/**
 * CAPTCHAs. The runner never solves one by itself: it does not read the
 * picture, run OCR, ask a model or use a solving service. Either the person
 * watching the live view types the answer in the job chat, or the sign-in or
 * journey stops and is reported as blocked by a CAPTCHA, never as a product bug.
 *
 *   detectCaptcha(page)       "text", "widget" or "none", and marks what it found
 *   solveWithPerson(...)      asks, types the answer, submits, asks again if refused
 *   CaptchaBlocked            thrown when nobody can answer; its message is the report line
 *
 * Used by the shared sign-in gate (qa/explore/crawl.ts) and the Probe's step
 * runner (qa/probe/execute.ts). The rules themselves are plain data next to
 * SECRET_FIELD_RULES in qa/lib/live-view.ts.
 */

export type CaptchaKind = "text" | "widget" | "none";

/** Answers tried before giving up, the first one included. */
export const MAX_CAPTCHA_TRIES = 3;

const FIRST_PROMPT = "The sign-in page shows a CAPTCHA. Type the characters you see in the live view.";
const PAGE_PROMPT = "The page shows a CAPTCHA. Type the characters you see in the live view.";
const AGAIN_PROMPT = "That was not accepted. Type the new characters.";

export const WIDGET_WHY = "a third-party CAPTCHA widget cannot be answered by typing";

export function blockedByCaptcha(where: string, why: string): string {
  return `Blocked by a CAPTCHA on ${where} (${why}): a person has to solve it, or the site's owners must give the QA account a test bypass.`;
}

/** Nobody could answer. The message is the line for the report and the chat. */
export class CaptchaBlocked extends Error {
  constructor(where: string, why: string) {
    super(blockedByCaptcha(where, why));
  }
}

/** Why nobody can answer right now, or null when a person is watching. */
export function nobodyToAsk(): string | null {
  if (!linked()) return "no person is connected to this run";
  if (!attended()) return "this run is unattended";
  return null;
}

/**
 * Runs in the page, so it uses no imports. Finds a visible third-party widget
 * or a visible CAPTCHA answer field and marks it (and the picture next to it)
 * with CAPTCHA_RULES.attribute, so Playwright can find exactly that again.
 */
function markCaptcha(rules: CaptchaRules): CaptchaKind {
  const A = rules.attribute;
  // Attributes change only when the finding changes, so the Probe's page-change counter does not see this.
  const found = new Map<Element, string>();
  const finish = (kind: CaptchaKind): CaptchaKind => {
    for (const el of Array.from(document.querySelectorAll(`[${A}]`))) if (!found.has(el)) el.removeAttribute(A);
    for (const [el, value] of found) if (el.getAttribute(A) !== value) el.setAttribute(A, value);
    return kind;
  };
  const visible = (el: Element): boolean => {
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    return !el.closest('[aria-hidden="true"], [inert]');
  };

  const widgetRe = new RegExp(rules.widgetSource, "i");
  const invisibleRe = new RegExp(rules.invisibleSource, "i");
  const widget = Array.from(document.querySelectorAll("iframe")).find((frame) => {
    const src = frame.getAttribute("src") || "";
    const title = frame.getAttribute("title") || "";
    return (widgetRe.test(src) || widgetRe.test(title)) && !invisibleRe.test(src) && visible(frame);
  });
  if (widget) {
    found.set(widget, "widget");
    return finish("widget");
  }

  const fieldRe = new RegExp(rules.fieldSource, "i");
  const idText = (ids: string | null) =>
    (ids || "").split(" ").filter(Boolean).map((id) => document.getElementById(id)?.textContent || "").join(" ");
  const wordsOf = (el: HTMLInputElement): string =>
    [
      el.getAttribute("name"),
      el.getAttribute("id"),
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
      idText(el.getAttribute("aria-labelledby")),
      ...Array.from(el.labels ?? []).map((label) => label.textContent),
    ].join(" ");
  const notText = ["hidden", "password", "checkbox", "radio", "submit", "button", "file", "email"];
  const field = Array.from(document.querySelectorAll("input"))
    .filter(visible)
    .find((el) => !notText.includes((el.getAttribute("type") || "text").toLowerCase()) && fieldRe.test(wordsOf(el)));
  if (!field) return finish("none");
  found.set(field, "input");

  // The picture: the nearest visible image above the field, a few levels up at most.
  let box: Element | null = field.parentElement;
  for (let level = 0; box && level < 3; level++, box = box.parentElement) {
    const image = Array.from(box.querySelectorAll('img, svg, canvas, [role="img"]')).find(visible);
    if (image) {
      found.set(image, "image");
      break;
    }
  }
  return finish("text");
}

/** Is there a visible CAPTCHA on this page, and which kind? Never throws: a page that cannot be read has none. */
export async function detectCaptcha(page: Page): Promise<CaptchaKind> {
  await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn);").catch(() => {});
  return page.evaluate(markCaptcha, CAPTCHA_RULES).catch(() => "none" as const);
}

const markedAs = (page: Page, what: "input" | "image") => page.locator(`[${CAPTCHA_RULES.attribute}="${what}"]`).first();

/** The marked answer field. Call detectCaptcha first. */
export const captchaField = (page: Page): Locator => markedAs(page, "input");

/** True when target is the CAPTCHA field itself. Call detectCaptcha first. */
export async function isCaptchaField(target: Locator): Promise<boolean> {
  return target.evaluate((el, attribute) => el.getAttribute(attribute) === "input", CAPTCHA_RULES.attribute).catch(() => false);
}

/**
 * True when clicking target submits the CAPTCHA's form: a submit button in the
 * same form, or, when neither is in a form (screens built without one), any
 * button. Links and other controls never count. Call detectCaptcha first.
 */
export async function sharesFormWithCaptcha(target: Locator): Promise<boolean> {
  return target
    .evaluate((el, attribute) => {
      const captcha = document.querySelector(`[${attribute}="input"], [${attribute}="widget"]`);
      if (!captcha) return false;
      const type = (el.getAttribute("type") || "").toLowerCase();
      const isButton = el.tagName === "BUTTON" || el.getAttribute("role") === "button" || (el.tagName === "INPUT" && ["submit", "button"].includes(type));
      const mine = el.closest("form");
      const theirs = captcha.closest("form");
      if (mine && theirs) return mine === theirs && (el.tagName === "BUTTON" ? type === "" || type === "submit" : type === "submit");
      return !mine && !theirs && isButton;
    }, CAPTCHA_RULES.attribute)
    .catch(() => false);
}

/**
 * The site refused the answer: its CAPTCHA error shows within waitMs, or the
 * CAPTCHA is still there afterwards, emptied, with no other error on screen.
 * A CAPTCHA that went away means it was accepted.
 */
export async function captchaRejected(page: Page, waitMs = 5000): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (true) {
    if ((await detectCaptcha(page)) !== "text") return false;
    if (await page.locator(CAPTCHA_RULES.errorSelector).filter({ visible: true }).count().catch(() => 0)) return true;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const empty = (await captchaField(page).inputValue({ timeout: 1000 }).catch(() => "x")) === "";
  const otherError = await page.locator('[role="alert"]').filter({ visible: true }).count().catch(() => 0);
  return empty && otherError === 0;
}

/** Shows the picture in the live view, then asks. Throws CaptchaBlocked when no answer comes. */
async function askPerson(page: Page, where: string, prompt: string): Promise<string> {
  const image = markedAs(page, "image");
  await liveAction(page, "Waiting for you to read the CAPTCHA", (await image.count()) ? image : captchaField(page));
  await liveFrameNow(page);
  let values: Record<string, unknown>;
  try {
    values = await ask({ kind: "text", prompt, event: "captcha" });
  } catch {
    throw new CaptchaBlocked(where, "no answer came in time");
  }
  const text = typeof values.text === "string" ? values.text.trim() : "";
  if (!text) throw new CaptchaBlocked(where, "no answer was given");
  return text;
}

export type SolveOptions = {
  /** Called before each try: fill the form's other fields again, in case the site cleared them. */
  fillRest?: () => Promise<void>;
  /** Submits the form and waits for the page to settle. */
  submit: () => Promise<void>;
  /** The field already holds the person's answer, so the first try submits without asking. */
  answered?: boolean;
  /** "sign-in" words the first question for a sign-in page. */
  context?: "sign-in" | "page";
};

/**
 * Asks the person, types the answer, submits; asks again while the site
 * refuses it, up to MAX_CAPTCHA_TRIES answers. Returns once the CAPTCHA was
 * not refused (the caller then checks the rest, a wrong password for one).
 * Throws CaptchaBlocked when nobody can answer or every answer was refused.
 */
export async function solveWithPerson(page: Page, where: string, options: SolveOptions): Promise<void> {
  const nobody = nobodyToAsk();
  if (nobody) throw new CaptchaBlocked(where, nobody);
  const first = options.context === "sign-in" ? FIRST_PROMPT : PAGE_PROMPT;
  for (let attempt = 1; attempt <= MAX_CAPTCHA_TRIES; attempt++) {
    await options.fillRest?.();
    if (!(attempt === 1 && options.answered)) {
      const answer = await askPerson(page, where, attempt === 1 ? first : AGAIN_PROMPT);
      // Minutes may have passed: find the field again.
      if ((await detectCaptcha(page)) !== "text") return;
      const field = captchaField(page);
      await liveAction(page, "Typing the CAPTCHA answer", field);
      await field.fill(answer, { timeout: 5000 });
    }
    await options.submit();
    if (!(await captchaRejected(page))) return;
  }
  throw new CaptchaBlocked(where, `${MAX_CAPTCHA_TRIES} answers were not accepted`);
}

/** Asks for the answer only, for a step that fills the CAPTCHA field and submits later. */
export async function captchaAnswerFromPerson(page: Page, where: string): Promise<string> {
  const nobody = nobodyToAsk();
  if (nobody) throw new CaptchaBlocked(where, nobody);
  return askPerson(page, where, PAGE_PROMPT);
}
