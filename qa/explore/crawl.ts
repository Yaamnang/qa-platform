import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { askCode, askLogin, inbox, linked, say, SignInSkipped } from "../lib/console-link";
import { CaptchaBlocked, detectCaptcha, nobodyToAsk, solveWithPerson, WIDGET_WHY, blockedByCaptcha } from "../lib/captcha";
import { attachLiveView, CAPTCHA_RULES, liveAction, SECRET_FIELD_RULES, type SecretFieldRules } from "../lib/live-view";
import { freshCode } from "../lib/totp";
import { submitCode, submitPassword } from "../lib/ui";
import { installReadOnlyGuard, SIGN_IN_WINDOW_MS, type ReadOnlyGuard } from "./readonly";
import type { BlockedWrite, ControlMap, ExploreMap, LinkMap, PageMap } from "./types";

/**
 * Phase 1: explore.
 *
 * Opens the target as a signed-out visitor and walks it breadth-first from
 * the page it lands on, writing down what it sees. It signs in only when the
 * walk reaches a sign-in screen (a visible password field), at most once per
 * run, with generic form filling that works on any site (SignInGate below).
 * It navigates by URL only and never clicks a button or submits a form, apart
 * from that sign-in form and the stand-in's organization picker. The
 * read-only guard in `readonly.ts` enforces that at the network level, so a
 * mistake in this file still cannot change anything on the target.
 *
 * Three independent stops, so the walk always terminates: a page cap, a depth
 * cap, and a wall-clock budget.
 */

/** A blank password means no saved login: the gate asks in the console, or skips the sign-in screen. */
export type Credentials = { email: string; password: string; totpSecret: string };

export type CrawlOptions = {
  /** Origin to explore, for example http://localhost:3100. */
  origin: string;
  /** Path and query on that origin to start from, for example / or /pricing. */
  start: string;
  credentials: Credentials;
  maxPages: number;
  maxDepth: number;
  budgetMs: number;
  headed: boolean;
  log: (line: string) => void;
};

/** The target did not load at all. Exit code 2. A refused sign-in is only a note. */
export class ExploreUnavailable extends Error {}

/** At most this many pages per route template, so 40 job pages do not fill the map. */
export const MAX_PER_TEMPLATE = 2;

/** Links the crawler must never follow, even though following them would be a GET. */
export const NEVER_FOLLOW = /(^|\/)(logout|signout|sign-out)(\/|$)/i;

export const DOWNLOAD_EXTENSION = /\.(csv|json|pdf|xlsx|xls|zip|txt)$/i;

/** /jobs/job_a1b2 and /jobs/job_c3d4 are the same page with different data. */
export function templateOf(route: string): string {
  const [pathname] = route.split("?");
  const parts = pathname.split("/").map((segment) =>
    /^(job|doc|usr|t|org|inv)_[\w-]+$/i.test(segment) || /^\d+$/.test(segment) || /^[0-9a-f-]{12,}$/i.test(segment)
      ? ":id"
      : segment,
  );
  return parts.join("/") || "/";
}

// ---------------------------------------------------------------------------
// What one page looks like. This function is serialised and runs in the page,
// so it takes no arguments from here and uses no imports.
// ---------------------------------------------------------------------------

export type Extracted = Pick<PageMap, "title" | "headings" | "forms" | "buttons" | "links" | "tables">;

function extractPageShape(): Extracted {
  const CAP = 140;
  const clean = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim().slice(0, CAP);
  const textOf = (el: Element | null | undefined): string => clean(el?.textContent);

  const labelledByText = (el: Element): string => {
    const ids = clean(el.getAttribute("aria-labelledby")).split(" ").filter(Boolean);
    return clean(ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" "));
  };

  /** Close enough to the accessible name for a map a person will read. */
  const accessibleName = (el: Element): string =>
    clean(el.getAttribute("aria-label")) || labelledByText(el) || textOf(el) || clean(el.getAttribute("title")) || clean(el.getAttribute("value"));

  const headingElements = Array.from(document.querySelectorAll("h1, h2, h3"));

  /** The last heading that appears before this element: what a reader would call this section. */
  const headingAbove = (el: Element): string => {
    let best: Element | null = null;
    for (const heading of headingElements) {
      if (heading.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = heading;
    }
    return best ? textOf(best) : "";
  };

  const fieldLabel = (el: Element): string => {
    const direct = clean(el.getAttribute("aria-label")) || labelledByText(el);
    if (direct) return direct;
    const id = el.getAttribute("id");
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label) return textOf(label);
    }
    const wrapping = el.closest("label");
    if (wrapping) return textOf(wrapping);
    return clean(el.getAttribute("placeholder")) || clean(el.getAttribute("name")) || "(unlabelled)";
  };

  const FIELD_SELECTOR = "input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea";
  const fieldElements = Array.from(document.querySelectorAll(FIELD_SELECTOR));

  const describeFields = (elements: Element[]) =>
    elements.slice(0, 20).map((el) => {
      const tag = el.tagName.toLowerCase();
      const type = tag === "select" || tag === "textarea" ? tag : clean(el.getAttribute("type")) || "text";
      const options =
        tag === "select"
          ? Array.from((el as HTMLSelectElement).options).map((option) => clean(option.textContent)).filter(Boolean).slice(0, 12)
          : [];
      // No value is ever read here. The map describes the shape of a field,
      // never its contents, which is what keeps typed secrets out of the file.
      return {
        label: fieldLabel(el),
        name: clean(el.getAttribute("name")),
        type,
        required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
        ...(options.length ? { options } : {}),
      };
    });

  const formElements = Array.from(document.querySelectorAll("form")).slice(0, 10);
  const formName = (form: HTMLFormElement, index: number): string =>
    clean(form.getAttribute("aria-label")) ||
    labelledByText(form) ||
    textOf(form.querySelector("legend, h1, h2, h3")) ||
    headingAbove(form) ||
    `(unnamed form ${index + 1})`;

  const forms = formElements.map((form, index) => ({
    name: formName(form, index),
    submitsTo: clean(form.getAttribute("action")) || "(no action attribute: the page sends this itself)",
    method: (clean(form.getAttribute("method")) || "(none)").toUpperCase(),
    fields: describeFields(fieldElements.filter((el) => el.closest("form") === form)),
    submitLabels: Array.from(form.querySelectorAll("button:not([type=button]), input[type=submit]"))
      .map((el) => accessibleName(el))
      .filter(Boolean)
      .slice(0, 5),
  }));

  // React screens often have no <form> element at all. Their fields still
  // matter, so they are reported together under one entry.
  const loose = fieldElements.filter((el) => !el.closest("form"));
  if (loose.length) {
    forms.push({
      name: "(fields that are not inside a form element)",
      submitsTo: "(no form element: the page sends these itself)",
      method: "(none)",
      fields: describeFields(loose),
      submitLabels: [],
    });
  }

  const nameOfOwningForm = (el: Element): string | null => {
    const owner = el.closest("form");
    if (!owner) return null;
    const index = formElements.indexOf(owner as HTMLFormElement);
    return index >= 0 ? forms[index].name : null;
  };

  // Deduplicated: a responsive shell often renders the same control twice, once
  // for mobile and once for desktop, and listing both only pads the map.
  const buttons: ControlMap[] = [];
  for (const el of Array.from(document.querySelectorAll('button, [role="button"], input[type=submit], input[type=button]'))) {
    if (buttons.length >= 40) break;
    const explicitType = clean(el.getAttribute("type"));
    const entry: ControlMap = {
      name: accessibleName(el) || "(no accessible name)",
      testId: el.getAttribute("data-testid"),
      disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
      type: explicitType || (el.tagName === "BUTTON" && el.closest("form") ? "submit" : "button"),
      inFormNamed: nameOfOwningForm(el),
    };
    if (!buttons.some((seen) => seen.name === entry.name && seen.testId === entry.testId && seen.type === entry.type)) {
      buttons.push(entry);
    }
  }

  const links: LinkMap[] = [];
  for (const anchor of Array.from(document.querySelectorAll("a[href]")).slice(0, 120)) {
    const raw = anchor.getAttribute("href") ?? "";
    let url: URL | null = null;
    try {
      url = new URL(raw, location.href);
    } catch {
      url = null;
    }
    const sameOrigin = !!url && url.origin === location.origin && /^https?:$/.test(url.protocol);
    const isDownload = anchor.hasAttribute("download") || (!!url && /\.(csv|json|pdf|xlsx|xls|zip|txt)$/i.test(url.pathname));
    const kind: LinkMap["kind"] = !sameOrigin ? "external" : isDownload ? "download" : "internal";
    const href = sameOrigin && url ? url.pathname + url.search : raw;
    const entry = { name: accessibleName(anchor) || "(no link text)", href, testId: anchor.getAttribute("data-testid"), kind };
    if (!links.some((seen) => seen.href === entry.href && seen.name === entry.name)) links.push(entry);
  }

  // Real tables and the ARIA pattern both count: plenty of apps build a grid out
  // of divs, and a check against its columns is just as valuable.
  const tables = Array.from(document.querySelectorAll('table, [role="table"], [role="grid"]'))
    .slice(0, 10)
    .map((table) => {
      const headerCells = Array.from(table.querySelectorAll('thead th, [role="columnheader"]'));
      const fallbackCells = Array.from(table.querySelectorAll("tr:first-child th"));
      const columns = (headerCells.length ? headerCells : fallbackCells).map((cell) => textOf(cell)).filter(Boolean);
      // Approximate: a header row that is not inside a thead is counted out again.
      const bodyRows = table.querySelectorAll("tbody tr").length;
      const allRows = table.querySelectorAll('tr, [role="row"]').length;
      return {
        name: clean(table.getAttribute("aria-label")) || textOf(table.querySelector("caption")) || headingAbove(table) || "(unnamed table)",
        columns,
        rowCount: bodyRows || Math.max(0, allRows - (columns.length ? 1 : 0)),
        testId: table.getAttribute("data-testid"),
      };
    });

  return {
    title: clean(document.title),
    headings: headingElements
      .map((heading) => ({ level: Number(heading.tagName.slice(1)), text: textOf(heading) }))
      .filter((heading) => heading.text)
      .slice(0, 20),
    forms,
    buttons,
    links,
    tables,
  };
}

// ---------------------------------------------------------------------------
// Sign in, only when the walk reaches a sign-in screen
// ---------------------------------------------------------------------------

export const pathOf = (page: Page): string => {
  const url = new URL(page.url());
  return url.pathname + url.search;
};

/** What the sign-in code found on screen. Filled in by markSignInForm, in the page. */
type SignInMarks = {
  /** A visible password field. This is what makes a page a sign-in screen. */
  password: boolean;
  username: boolean;
  /** A visible one-time code field, and no password field. */
  code: boolean;
  /** The submit button of the form that holds the marked field, when it has one. */
  submit: boolean;
  /** Origin the marked field's form posts to: its action, or the page itself. */
  actionOrigin: string | null;
  /** A captcha or bot challenge is on screen. */
  botWall: boolean;
};

const NO_MARKS: SignInMarks = { password: false, username: false, code: false, submit: false, actionOrigin: null, botWall: false };

/** The attribute markSignInForm puts on the fields it chose, so Playwright can find exactly those again. */
const SIGN_IN_ATTRIBUTE = SECRET_FIELD_RULES.attribute;

/**
 * Finds the sign-in fields on any site, not just the stand-in, and marks them.
 * Runs in the page, so it uses no imports. Its only argument is the shared
 * SECRET_FIELD_RULES (qa/lib/live-view.ts), so the live view masks exactly
 * the kind of field this treats as a password or one-time code.
 *
 * Generic on purpose: no label text, no test id. The scope is the form that
 * holds the visible password field. The username is the visible input in that
 * form whose autocomplete says username or email, else the last email, text or
 * tel input before the password field. Only visible elements count and only
 * one element gets each mark, so a page with two "Email" fields (a header
 * search, a mobile and a desktop copy) cannot cause a strict-mode error.
 */
function markSignInForm(rules: SecretFieldRules): SignInMarks {
  const ATTRIBUTE = rules.attribute;
  for (const el of Array.from(document.querySelectorAll(`[${ATTRIBUTE}]`))) el.removeAttribute(ATTRIBUTE);

  const visible = (el: Element): boolean => {
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    return !el.closest('[aria-hidden="true"], [inert]');
  };
  const typeOf = (el: Element): string => (el.getAttribute("type") || "text").toLowerCase();
  const inputs = Array.from(document.querySelectorAll("input")).filter(visible);
  const submitIn = (form: HTMLFormElement | null): Element | undefined =>
    form ? Array.from(form.querySelectorAll("button[type=submit], input[type=submit], button:not([type])")).find(visible) : undefined;
  const originOf = (form: HTMLFormElement | null): string => {
    try {
      return new URL(form?.getAttribute("action") || location.href, location.href).origin;
    } catch {
      return location.origin;
    }
  };

  // Bot walls. An invisible reCAPTCHA (v3, size=invisible) does not stop a
  // person, so only a challenge someone would have to solve counts.
  const challengeFrame = Array.from(document.querySelectorAll("iframe")).some((frame) => {
    const src = frame.getAttribute("src") || "";
    return /google\.com\/recaptcha|recaptcha\.net|hcaptcha\.com|challenges\.cloudflare\.com/i.test(src) && !/size=invisible/i.test(src) && visible(frame);
  });
  const challengeText = /verify (that )?you are (a )?human|are you a robot|i'?m not a robot|checking (if the site connection is secure|your browser)/i.test(
    document.body?.innerText || "",
  );
  const botWall = challengeFrame || challengeText;

  const password = inputs.find((el) => typeOf(el) === "password");
  if (password) {
    password.setAttribute(ATTRIBUTE, "password");
    const form = password.closest("form");
    const scope = inputs.filter((el) => el !== password && (form ? el.closest("form") === form : true));
    const byAutocomplete = scope.find((el) => /\b(username|email)\b/i.test(el.getAttribute("autocomplete") || ""));
    const before = scope.filter(
      (el) => ["email", "text", "tel"].includes(typeOf(el)) && !!(el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING),
    );
    const username = byAutocomplete || before[before.length - 1];
    if (username) username.setAttribute(ATTRIBUTE, "username");
    const submit = submitIn(form);
    if (submit) submit.setAttribute(ATTRIBUTE, "submit");
    return { password: true, username: !!username, code: false, submit: !!submit, actionOrigin: originOf(form), botWall };
  }

  const labelOf = (el: HTMLInputElement): string =>
    [el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("name"), ...Array.from(el.labels ?? []).map((l) => l.textContent)].join(" ");
  const codeCandidates = inputs.filter((el) => !["hidden", "checkbox", "radio", "submit", "button"].includes(typeOf(el)));
  const maxLength = (el: HTMLInputElement) => Number(el.getAttribute("maxlength") || 0);
  const code =
    codeCandidates.find((el) => (el.getAttribute("autocomplete") || "").toLowerCase() === rules.codeAutocomplete) ||
    codeCandidates.find((el) => el.getAttribute("inputmode") === "numeric" && maxLength(el) >= rules.codeMinLength && maxLength(el) <= rules.codeMaxLength) ||
    codeCandidates.find((el) => new RegExp(rules.codeWord, "i").test(labelOf(el)) && !new RegExp(rules.notCodeSource, "i").test(labelOf(el)));
  if (code) {
    code.setAttribute(ATTRIBUTE, "code");
    const form = code.closest("form");
    const submit = submitIn(form);
    if (submit) submit.setAttribute(ATTRIBUTE, "submit");
    return { password: false, username: false, code: true, submit: !!submit, actionOrigin: originOf(form), botWall };
  }
  return { password: false, username: false, code: false, submit: false, actionOrigin: null, botWall };
}

async function readSignInMarks(page: Page): Promise<SignInMarks> {
  await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn);").catch(() => {});
  return page.evaluate(markSignInForm, SECRET_FIELD_RULES).catch(() => NO_MARKS);
}

const marked = (page: Page, name: "password" | "username" | "code" | "submit") => page.locator(`[${SIGN_IN_ATTRIBUTE}="${name}"]`).first();

/** A page is a sign-in screen when it shows a visible password field. Nothing else is needed to tell. */
export async function isSignInScreen(page: Page): Promise<boolean> {
  return page.locator('input[type="password"]:visible').first().isVisible().catch(() => false);
}

/** Where the page is, for notes: the path on the target, or host and path when it is somewhere else. */
function whereIs(page: Page, origin: string): string {
  const url = new URL(page.url());
  return url.origin === origin ? url.pathname + url.search : `${url.host}${url.pathname}`;
}

/** The page's own error message after a refused sign-in, if it shows one. Never a field value. */
async function shownAlert(page: Page): Promise<string> {
  const alert = page.locator('[role="alert"]:visible').first();
  const text = (await alert.innerText({ timeout: 1_000 }).catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 160);
  return text ? ` The page said: "${text}"` : "";
}

/**
 * Opens the read-only guard's sign-in window, submits the form that holds
 * `field`, and waits for navigation or for the field to go away. The window
 * closes once the page has settled, or by itself after 15 seconds.
 */
async function submitSignInForm(page: Page, guard: ReadOnlyGuard, field: Locator, hasSubmit: boolean, actionOrigin: string | null, captcha = false): Promise<void> {
  const before = page.url();
  const submit = marked(page, "submit");
  await liveAction(page, "Submitting the sign-in form", hasSubmit ? submit : field);
  guard.openSignInWindow(actionOrigin);
  try {
    if (hasSubmit) await submit.click({ timeout: 5_000 });
    else await field.press("Enter", { timeout: 5_000 });
    await Promise.race([
      page.waitForURL((url) => url.href !== before, { timeout: SIGN_IN_WINDOW_MS }),
      field.waitFor({ state: "hidden", timeout: SIGN_IN_WINDOW_MS }),
      // With a CAPTCHA, a refused answer shows quickly and is worth not waiting 15 seconds for.
      ...(captcha ? [page.locator(CAPTCHA_RULES.errorSelector).filter({ visible: true }).first().waitFor({ timeout: SIGN_IN_WINDOW_MS })] : []),
    ]).catch(() => {});
    await settle(page);
  } finally {
    guard.closeSignInWindow();
  }
}

/** The stand-in's organization picker. Returns the organization opened, if any. */
async function openOrganization(page: Page, notes: string[]): Promise<string | null> {
  if (!/\/orgs\/?$/.test(new URL(page.url()).pathname)) return null;

  // The picker is rendered in the browser, so wait for it instead of asking
  // for a count straight away: count() does not wait and would always be 0.
  const openButtons = page.getByRole("button", { name: /^Open / });
  const first = openButtons.first();
  await first.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  if (!(await first.isVisible())) {
    notes.push("The organization picker had no 'Open ...' button, so the crawl started from there.");
    return null;
  }
  const choices = await openButtons.count();
  if (choices > 1) {
    // The suite's own sign-in stops the run when the bot can open more than one
    // organization, because that breaks least privilege. Here it is a loud note
    // rather than a stop: a deployment nobody has mapped yet may legitimately
    // have several, and the explorer cannot tell which one is synthetic.
    notes.push(`The account can open ${choices} organizations. A QA account should have exactly one. The crawl used the first.`);
  }
  const label = (await first.getAttribute("aria-label")) ?? (await first.innerText());
  const organization = label.replace(/^Open\s+/, "").trim();
  await liveAction(page, `Clicking 'Open ${organization}'`, first);
  await first.click();
  await page.waitForURL((url) => !/\/orgs\/?$/.test(url.pathname), { timeout: 20_000 }).catch(() => {});
  return organization;
}

/**
 * The stand-in's own sign-in, with its own labels. Kept only as a fallback for
 * when the generic form filling above could not find or fill the fields. It
 * posts only to the stand-in's three allow-listed endpoints, so on any other
 * site the read-only guard blocks whatever it tries.
 */
async function standInSignIn(page: Page, credentials: Credentials): Promise<void> {
  await liveAction(page, "Opening /fake/login");
  await submitPassword(page, credentials.email, credentials.password);
  const code = credentials.totpSecret ? await freshCode(credentials.totpSecret) : null;
  if (!code) throw new Error("no authenticator key for the one-time code");
  await liveAction(page, "Typing the one-time code", page.getByLabel("Authentication code"));
  await submitCode(page, code);
  await page.waitForURL((url) => !/\/login\/?$/.test(url.pathname), { timeout: 20_000 }).catch(() => {});
  if (/\/login\/?$/.test(new URL(page.url()).pathname)) throw new Error(`the stand-in kept the sign-in page open.${await shownAlert(page)}`);
}


/** Signing in, at most once per run, and only when the walk reaches a sign-in screen. */
export type SignInGate = {
  /** True once a sign-in screen was handled, whatever the outcome. */
  readonly attempted: boolean;
  readonly signedIn: boolean;
  /** The organization the stand-in's picker opened, if it showed one. */
  readonly organization: string | null;
  /** Set when a CAPTCHA stopped the sign-in and nobody could answer it: the line for the report. */
  readonly blocked: string | null;
  /**
   * If the page is a sign-in screen and no attempt was made yet, tries once.
   * Returns true when it signed in. Never throws: a sign-in that fails is a
   * note, and the walk carries on with public pages.
   */
  maybeSignIn(page: Page): Promise<boolean>;
};

export type GateContext = Pick<CrawlOptions, "origin" | "credentials" | "log"> & { guard: ReadOnlyGuard; notes: string[] };

export function signInGate(context: GateContext): SignInGate {
  const { origin, credentials, log, guard, notes } = context;
  let attempted = false;
  let signedIn = false;
  let organization: string | null = null;
  let blocked: string | null = null;

  /** One line in the notes, the log and the chat. */
  const tell = async (line: string, event: string) => {
    notes.push(line);
    log(`• ${line}`);
    await say(line, event);
  };

  type Outcome = { kind: "signed-in" } | { kind: "stopped" } | { kind: "unfillable"; why: string };

  /** A CAPTCHA nobody can answer: a "could not test" line, never a product failure. */
  const block = async (line: string): Promise<Outcome> => {
    blocked = line;
    await tell(line, "captcha-blocked");
    return { kind: "stopped" };
  };

  async function generic(page: Page, where: string): Promise<Outcome> {
    let marks = await readSignInMarks(page);
    const captcha = await detectCaptcha(page);
    if (captcha === "widget") return block(blockedByCaptcha(where, WIDGET_WHY));
    if (marks.botWall) return block(blockedByCaptcha(where, "the page shows a bot check"));
    const nobody = captcha === "text" ? nobodyToAsk() : null;
    if (nobody) return block(blockedByCaptcha(where, nobody));

    if (!credentials.password) {
      if (!linked()) {
        await tell(`Sign-in screen found at ${where}, skipped (no login available).`, "sign-in-skipped");
        return { kind: "stopped" };
      }
      try {
        const login = await askLogin(
          `The sign-in page at ${where} on ${new URL(page.url()).host} is asking for the QA account's email and password. Send the login, or skip to explore public pages only.`,
        );
        credentials.email = login.email;
        credentials.password = login.password;
      } catch (error) {
        const why = error instanceof SignInSkipped ? "the employee chose to skip it" : "no login was sent in time";
        await tell(`Sign-in screen found at ${where}, skipped (${why}).`, "sign-in-skipped");
        return { kind: "stopped" };
      }
      // Minutes may have passed, and the page may have moved on.
      marks = await readSignInMarks(page);
    }
    if (!marks.password) return { kind: "unfillable", why: "the password field was gone by the time the login arrived" };

    log("• Signing in…");
    const fillLogin = async () => {
      if (marks.username) {
        await liveAction(page, "Typing the email", marked(page, "username"));
        await marked(page, "username").fill(credentials.email, { timeout: 5_000 });
      }
      await liveAction(page, "Typing the password", marked(page, "password"));
      await marked(page, "password").fill(credentials.password, { timeout: 5_000 });
    };
    try {
      if (captcha === "text") {
        // A person types the CAPTCHA; the rest of the form is filled again before each try.
        await solveWithPerson(page, where, {
          context: "sign-in",
          fillRest: async () => {
            marks = await readSignInMarks(page);
            if (!marks.password) throw new Error("the password field was gone");
            await fillLogin();
          },
          submit: () => submitSignInForm(page, guard, marked(page, "password"), marks.submit, marks.actionOrigin, true),
        });
      } else {
        await fillLogin();
        await submitSignInForm(page, guard, marked(page, "password"), marks.submit, marks.actionOrigin);
      }
    } catch (error) {
      if (error instanceof CaptchaBlocked) return block(error.message);
      return { kind: "unfillable", why: (error as Error).message.split("\n")[0] };
    }

    marks = await readSignInMarks(page);
    if (marks.botWall) return block(blockedByCaptcha(whereIs(page, origin), "the page shows a bot check"));
    if (marks.password) {
      await tell(`Sign-in at ${where} did not complete: the password was not accepted.${await shownAlert(page)} Explored public pages only.`, "sign-in-failed");
      return { kind: "stopped" };
    }

    if (marks.code) {
      let code: string;
      if (credentials.totpSecret) {
        code = await freshCode(credentials.totpSecret);
      } else if (linked()) {
        try {
          const answer = await askCode("The sign-in page is asking for a one-time code. Send the current code, or the authenticator setup key, or skip.");
          if ("totpSecret" in answer) credentials.totpSecret = answer.totpSecret;
          code = "code" in answer ? answer.code : await freshCode(answer.totpSecret);
        } catch (error) {
          const why = error instanceof SignInSkipped ? "the employee chose to skip it" : "no code was sent in time";
          await tell(`One-time code screen found at ${whereIs(page, origin)}, skipped (${why}). Explored public pages only.`, "sign-in-skipped");
          return { kind: "stopped" };
        }
        // Typed at once: a code is only good for a few seconds.
        marks = await readSignInMarks(page);
      } else {
        await tell(`One-time code screen found at ${whereIs(page, origin)}, skipped (no authenticator key available). Explored public pages only.`, "sign-in-skipped");
        return { kind: "stopped" };
      }
      if (!marks.code) {
        await tell(`Sign-in at ${where} did not complete: the code field was gone before the code could be typed.`, "sign-in-failed");
        return { kind: "stopped" };
      }
      try {
        const codeField = marked(page, "code");
        await liveAction(page, "Typing the one-time code", codeField);
        await codeField.fill(code, { timeout: 5_000 });
        await submitSignInForm(page, guard, codeField, marks.submit, marks.actionOrigin);
      } catch (error) {
        await tell(`Sign-in at ${where} did not complete: ${(error as Error).message.split("\n")[0]}`, "sign-in-failed");
        return { kind: "stopped" };
      }
      marks = await readSignInMarks(page);
      if (marks.botWall) return block(blockedByCaptcha(whereIs(page, origin), "the page shows a bot check"));
      if (marks.code || marks.password) {
        await tell(`Sign-in at ${where} did not complete: the one-time code was not accepted.${await shownAlert(page)} Explored public pages only.`, "sign-in-failed");
        return { kind: "stopped" };
      }
    }
    return { kind: "signed-in" };
  }

  return {
    get attempted() {
      return attempted;
    },
    get signedIn() {
      return signedIn;
    },
    get organization() {
      return organization;
    },
    get blocked() {
      return blocked;
    },
    async maybeSignIn(page) {
      if (attempted || !(await isSignInScreen(page))) return false;
      attempted = true;
      const where = whereIs(page, origin);
      log(`• Sign-in screen found at ${where}.`);
      try {
        let outcome = await generic(page, where);
        if (outcome.kind === "unfillable") {
          // The generic filling could not find or fill the fields. Last resort:
          // the stand-in's own labels, which only ever work on the stand-in.
          const why = outcome.why;
          try {
            await standInSignIn(page, credentials);
            outcome = { kind: "signed-in" };
          } catch (error) {
            await tell(`Sign-in at ${where} did not complete: ${why}; the stand-in fallback also failed (${(error as Error).message.split("\n")[0]}). Explored public pages only.`, "sign-in-failed");
            return false;
          }
        }
        if (outcome.kind !== "signed-in") return false;
        organization = await openOrganization(page, notes);
        signedIn = true;
        await settle(page);
        log(`• Signed in. Carrying on from ${whereIs(page, origin)}${organization ? ` in ${organization}` : ""}.`);
        await say(`Signed in. Carrying on from ${whereIs(page, origin)}.`, "signed-in");
        return true;
      } catch (error) {
        await tell(`Sign-in at ${where} did not complete: ${(error as Error).message.split("\n")[0]} Explored public pages only.`, "sign-in-failed");
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/**
 * Waits for the page to settle, as far as it can tell without knowing the
 * page. Shared with the AI explorer in agent.ts, which waits the same way
 * after every click.
 */
export async function settle(page: Page): Promise<void> {
  // Best-effort settle so client-rendered tables are in the DOM before reading
  // it. A test would use a condition-based wait on a known element; here there
  // is nothing known to wait for yet, and a timeout costs nothing but detail.
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  // A screen that is still loading would be mapped as an empty one, so wait for
  // any loading state to go away. aria-busy is the standard marker for it and
  // the stand-in uses it, like most accessible apps.
  await page.locator('[aria-busy="true"]').first().waitFor({ state: "detached", timeout: 3_000 }).catch(() => {});
}

/** What is on screen right now, in the map's shape. Never a field value. */
export async function readPageShape(page: Page): Promise<Extracted> {
  // extractPageShape is sent to the page as compiled JavaScript, and the
  // compiler (esbuild, through tsx) wraps every named function in a `__name`
  // helper that only exists back in this process. Define it as a no-op in the
  // page first, or the function throws the moment it runs. Passed as a string
  // so the compiler leaves this line alone.
  await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn);");
  return page.evaluate(extractPageShape);
}

async function visit(
  page: Page,
  route: string,
  depth: number,
  apiCalls: Set<string>,
  notes: string[],
): Promise<PageMap> {
  apiCalls.clear();
  let status: number | null = null;
  try {
    await liveAction(page, `Opening ${route}`);
    const response = await page.goto(route, { waitUntil: "domcontentloaded", timeout: 20_000 });
    status = response?.status() ?? null;
  } catch (error) {
    notes.push(`${route} did not load: ${(error as Error).message.split("\n")[0]}`);
  }
  await settle(page);

  const reached = pathOf(page);
  if (reached !== route) notes.push(`${route} redirected to ${reached}.`);
  const shape = await readPageShape(page);

  return {
    route: reached,
    template: templateOf(reached),
    depth,
    status,
    ...shape,
    apiCalls: [...apiCalls].sort(),
  };
}

export function shouldFollow(link: LinkMap, origin: string): boolean {
  if (link.kind !== "internal") return false;
  if (!link.href.startsWith("/")) return false;
  const pathname = link.href.split("?")[0];
  if (pathname.startsWith("/api/")) return false;
  if (DOWNLOAD_EXTENSION.test(pathname)) return false;
  if (NEVER_FOLLOW.test(pathname)) return false;
  return new URL(link.href, origin).origin === origin;
}

export type SessionOptions = Pick<CrawlOptions, "origin" | "start" | "credentials" | "headed" | "log">;

/** A browser on the target's start page, signed out, with the read-only guard already in place. */
export type Session = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** API calls seen since it was last cleared. The caller clears it before each page. */
  apiCalls: Set<string>;
  /** Signs in once, when the walk reaches a sign-in screen. */
  gate: SignInGate;
  /** Stops the live view and closes the browser. Call it when done, also on failure. */
  close(): Promise<void>;
};

/**
 * Starts Chromium, installs the read-only guard on a fresh context before
 * anything else can run, then opens the target as a signed-out visitor.
 * Shared by the rules crawler below and the AI explorer in agent.ts, so both
 * get exactly the same guard and the same sign-in gate.
 *
 * There is no sign-in up front. A real site's front page is public, and its
 * login form is not ours, so the walk maps what a visitor sees and deals
 * with signing in only if and when it reaches a sign-in screen (see
 * SignInGate). The only failure that stops the run here is the target not
 * loading at all.
 */
export async function openSession(options: SessionOptions, startedAt: string, blockedWrites: BlockedWrite[], notes: string[]): Promise<Session> {
  const browser = await chromium.launch({ headless: !options.headed }).catch((error: Error) => {
    throw new ExploreUnavailable(`Could not start Chromium (${error.message.split("\n")[0]}). Run: npx playwright install chromium`);
  });

  let stopLiveView = () => {};
  const close = async () => {
    stopLiveView();
    await browser.close();
  };
  try {
    const context: BrowserContext = await browser.newContext({
      baseURL: options.origin,
      // Nothing is downloaded on purpose, and nothing should be written to disk by accident.
      acceptDownloads: false,
      viewport: { width: 1280, height: 800 },
      locale: "en-GB",
      timezoneId: "UTC",
      // Same header the suite sends, so ops can exclude this traffic from
      // analytics, billing and alerts.
      extraHTTPHeaders: { "X-QA-Run": `explore-${startedAt}` },
    });
    const guard = await installReadOnlyGuard(context, options.origin, blockedWrites, options.log);

    const apiCalls = new Set<string>();
    context.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin !== options.origin || !url.pathname.startsWith("/api/")) return;
      apiCalls.add(`${response.request().method()} ${url.pathname}`);
    });

    const page = await context.newPage();
    stopLiveView = attachLiveView(page);
    options.log(`• Opening ${options.origin}${options.start} as a signed-out visitor…`);
    await liveAction(page, `Opening ${options.start}`);
    await page.goto(options.start, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((error: Error) => {
      throw new ExploreUnavailable(`${options.origin}${options.start} did not load: ${error.message.split("\n")[0]}`);
    });
    await settle(page);

    const gate = signInGate({ origin: options.origin, credentials: options.credentials, log: options.log, guard, notes });
    return { browser, context, page, apiCalls, gate, close };
  } catch (error) {
    await close();
    throw error;
  }
}

const RULES_NOTE = "The employee sent directions during the walk. The built-in rules cannot follow them.";

export async function explore(options: CrawlOptions): Promise<ExploreMap> {
  const startedAt = new Date().toISOString();
  const notes: string[] = [];
  const blockedWrites: BlockedWrite[] = [];
  const pages: PageMap[] = [];

  const { context, page, apiCalls, gate, close } = await openSession(options, startedAt, blockedWrites, notes);
  try {
    const landing = pathOf(page);
    options.log(`• Exploring from ${landing} as a visitor`);
    await say(`Exploring from ${landing} as a visitor, with the built-in rules.`, "exploring");

    const queue: Array<{ route: string; depth: number }> = [{ route: landing, depth: 0 }];
    const queued = new Set<string>([landing]);
    const perTemplate = new Map<string, number>();
    const deadline = Date.now() + options.budgetMs;
    let stoppedBecause = "there was nothing left to explore";
    let hitDepthCap = false;

    while (queue.length) {
      if (pages.length >= options.maxPages) {
        stoppedBecause = `the page cap of ${options.maxPages} was reached`;
        break;
      }
      if (Date.now() >= deadline) {
        stoppedBecause = `the time budget of ${Math.round(options.budgetMs / 1000)}s ran out`;
        break;
      }
      const next = queue.shift()!;
      const template = templateOf(next.route);
      const seenOfTemplate = perTemplate.get(template) ?? 0;
      if (seenOfTemplate >= MAX_PER_TEMPLATE) continue;
      perTemplate.set(template, seenOfTemplate + 1);

      options.log(`  ${pages.length + 1}. ${next.route} (depth ${next.depth})`);
      await say(`Looking at ${next.route}.`, "page");
      // The rules walk follows links in a fixed order, so it cannot take directions. Say so once.
      if ((await inbox()).length && !notes.includes(RULES_NOTE)) {
        notes.push(RULES_NOTE);
        await say("The built-in rules follow a fixed order, so I cannot take directions. With an Anthropic key, Claude can.", "cannot-steer");
      }
      const mapped = await visit(page, next.route, next.depth, apiCalls, notes);
      pages.push(mapped);

      for (const link of mapped.links) {
        if (!shouldFollow(link, options.origin)) continue;
        if (queued.has(link.href)) continue;
        if (next.depth + 1 > options.maxDepth) {
          hitDepthCap = true;
          continue;
        }
        queued.add(link.href);
        queue.push({ route: link.href, depth: next.depth + 1 });
      }

      // Reached a sign-in screen: the gate signs in once, or notes why not.
      // Signed in, the page it lands on is mapped next, ahead of the public
      // pages still queued, which stay in the queue either way.
      if (await gate.maybeSignIn(page)) {
        const signedInLanding = pathOf(page);
        if (new URL(page.url()).origin === options.origin) {
          queued.add(signedInLanding);
          queue.unshift({ route: signedInLanding, depth: 0 });
        }
      }
    }
    if (hitDepthCap) notes.push(`Links deeper than ${options.maxDepth} hops from the landing page were not followed.`);
    if (queue.length) notes.push(`${queue.length} discovered route(s) were not visited because the walk stopped first.`);
    if (!gate.attempted) notes.push("No sign-in screen was reached, so only pages a visitor can see were mapped.");

    await context.close();
    return {
      version: 1,
      target: options.origin,
      startedAt,
      finishedAt: new Date().toISOString(),
      limits: { maxPages: options.maxPages, maxDepth: options.maxDepth, budgetMs: options.budgetMs },
      stoppedBecause,
      signedIn: gate.signedIn,
      organization: gate.organization,
      pages,
      blockedWrites,
      notes,
    };
  } finally {
    await close();
  }
}
