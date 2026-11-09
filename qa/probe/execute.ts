import { statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { isSignInScreen, pathOf, settle } from "../explore/crawl";
import { redact } from "../explore/redact";
import { say } from "../lib/console-link";
import { liveAction } from "../lib/live-view";
import { blockedCount, type ProbeSession } from "./session";
import type { JourneyResult, ProbeJourney, ProbeStep, StepResult } from "./types";

/**
 * Runs journeys deterministically. For each step: perform the action, then
 * check the declared outcome with a timeout. Nothing here asks a model.
 *
 *  - A click whose declared outcome does not happen fails the step.
 *  - A click after which nothing observable changed at all (URL, DOM, a
 *    same-origin request, a dialog, a new tab or a download) is the dead
 *    button case: "Button did nothing".
 *  - Off the allow-list, a step whose request the read-only guard blocked is
 *    skipped ("would change data, read-only on this host"), never failed.
 *  - A failed journey is run once more before it is reported, like the
 *    built-in suite. Passing the second time makes it flaky, not failed.
 *
 * Planning run only (calibrate): the plan is a guess, so a guess that does
 * not fit the site must not become a false alarm. A step whose element is
 * not on the page is dropped with the rest of its journey, and a click whose
 * exact outcome was mis-predicted but which visibly did something is kept as
 * "something changes". A dead button, a missing download and a blocked write
 * stay what they are. What survives is what gets recorded and replayed.
 */

const OUTCOME_TIMEOUT_MS = Number(process.env.PROBE_OUTCOME_TIMEOUT_MS) || 5000;
const CHANGE_WINDOW_MS = 3000;
const FIND_TIMEOUT_MS = 5000;
const READ_ONLY_SKIP = "would change data, read-only on this host";
export const DEAD_BUTTON = "Button did nothing";

type Marks = { url: string; mutations: number; requests: number; dialogs: number; newPages: number; downloads: number; blocked: number; openDialogs: number };

const DIALOGS = '[role="dialog"]:visible, [role="alertdialog"]:visible, dialog[open]';

async function mark(session: ProbeSession): Promise<Marks> {
  const { page, watch } = session;
  const mutations = Number(await page.evaluate("window.__probeMutationCount || 0").catch(() => 0));
  return {
    url: page.url(),
    mutations,
    requests: watch.requests,
    dialogs: watch.dialogs,
    newPages: watch.newPages,
    downloads: watch.downloads.length,
    blocked: blockedCount(session.blocked),
    openDialogs: await page.locator(DIALOGS).count().catch(() => 0),
  };
}

async function changed(session: ProbeSession, before: Marks): Promise<boolean> {
  const now = await mark(session);
  return (
    now.url !== before.url ||
    now.mutations !== before.mutations ||
    now.requests !== before.requests ||
    now.dialogs !== before.dialogs ||
    now.newPages !== before.newPages ||
    now.downloads !== before.downloads ||
    now.openDialogs !== before.openDialogs
  );
}

async function until(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await check().catch(() => false)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** What the step acts on, in words: "Download CSV" or "Email". */
function targetName(step: ProbeStep): string {
  return step.name || step.label || step.testId || step.path || "the control";
}

function candidates(page: Page, step: ProbeStep): Locator[] {
  const list: Locator[] = [];
  const role = step.role as Parameters<Page["getByRole"]>[0] | undefined;
  if (step.testId) list.push(page.getByTestId(step.testId));
  if (["fill", "select", "upload"].includes(step.action) && step.label) list.push(page.getByLabel(step.label, { exact: true }), page.getByLabel(step.label));
  if (role && step.name) {
    try {
      list.push(page.getByRole(role, { name: step.name, exact: true }), page.getByRole(role, { name: step.name }));
    } catch {
      // Not a role Playwright knows. The name alone below still works.
    }
  }
  if (step.label && !["fill", "select", "upload"].includes(step.action)) list.push(page.getByLabel(step.label, { exact: true }));
  if (step.name) {
    if (["fill", "select", "upload"].includes(step.action)) list.push(page.getByLabel(step.name), page.getByPlaceholder(step.name));
    else list.push(page.getByText(step.name, { exact: true }));
  }
  if (step.action === "upload") list.push(page.locator('input[type="file"]'));
  return list;
}

/** The first candidate that is on the page (visible, or attached for a file input), waiting up to FIND_TIMEOUT_MS. */
async function find(page: Page, step: ProbeStep): Promise<Locator | null> {
  const list = candidates(page, step);
  let found: Locator | null = null;
  await until(async () => {
    for (const candidate of list) {
      const first = candidate.first();
      if ((await first.count()) === 0) continue;
      if (step.action === "upload" || (await first.isVisible())) {
        found = first;
        return true;
      }
    }
    return false;
  }, FIND_TIMEOUT_MS);
  return found;
}

/** Obviously fake data, chosen by the field's type. A value that is a secret is never typed. */
async function fakeValue(field: Locator, planned: string | undefined, secrets: string[]): Promise<string> {
  const type = ((await field.getAttribute("type").catch(() => null)) ?? "text").toLowerCase();
  if (type === "email") return "qa-probe@example.com";
  if (type === "number") return "1";
  if (type === "tel") return "+10000000000";
  if (type === "url") return "https://example.com";
  if (type === "date") return "2026-01-01";
  const value = (planned ?? "").trim();
  if (!value || secrets.some((s) => s && value.includes(s))) return "QA Probe";
  return value;
}

function uploadFile(dir: string, accept: string): string {
  if (/image|png|jpe?g/i.test(accept)) {
    const file = path.join(dir, "qa-probe-upload.png");
    // A 1x1 transparent PNG.
    writeFileSync(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"));
    return file;
  }
  if (/pdf/i.test(accept)) {
    const file = path.join(dir, "qa-probe-upload.pdf");
    writeFileSync(file, "%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
    return file;
  }
  if (/text\/plain|\.txt/i.test(accept)) {
    const file = path.join(dir, "qa-probe-upload.txt");
    writeFileSync(file, "QA Probe test file\n");
    return file;
  }
  const file = path.join(dir, "qa-probe-upload.csv");
  writeFileSync(file, "name,value\nQA Probe,1\n");
  return file;
}

type Outcome = { ok: true } | { ok: false; headline: string; reason: string; elementMissing?: boolean };

export type ExecuteOptions = {
  session: ProbeSession;
  origin: string;
  readOnly: boolean;
  calibrate: boolean;
  workDir: string;
  secrets: () => string[];
  log: (line: string) => void;
  notes: string[];
};

async function signInIfAsked(options: ExecuteOptions): Promise<boolean> {
  const { page, gate } = options.session;
  if (gate.attempted || !(await isSignInScreen(page))) return false;
  return gate.maybeSignIn(page);
}

/** Performs one step. Returns null on success, otherwise why it failed. */
async function runStep(options: ExecuteOptions, step: ProbeStep): Promise<Outcome> {
  const { session } = options;
  const { page, watch } = session;
  const where = pathOf(page);
  const name = redact(targetName(step), options.secrets());

  let locator: Locator | null = null;
  let typed: string | null = null;
  let status: number | null = null;
  if (step.action !== "navigate") {
    locator = await find(page, step);
    if (!locator) {
      return { ok: false, elementMissing: true, headline: `"${name}" was not found on ${where}`, reason: `No element matched "${name}" within ${FIND_TIMEOUT_MS / 1000} s.` };
    }
  }
  const before = await mark(session);
  const downloadsBefore = watch.downloads.length;

  try {
    switch (step.action) {
      case "navigate": {
        await liveAction(page, `Opening ${step.path}`);
        const response = await page.goto(step.path ?? "/", { waitUntil: "domcontentloaded", timeout: 20_000 });
        status = response?.status() ?? null;
        break;
      }
      case "click":
      case "download":
        await liveAction(page, step.action === "download" ? `Downloading from '${name}'` : `Clicking '${name}'`, locator!);
        await locator!.click({ timeout: FIND_TIMEOUT_MS });
        break;
      case "fill": {
        const meta = await locator!.evaluate((el) => ({ type: (el.getAttribute("type") || "").toLowerCase(), ac: (el.getAttribute("autocomplete") || "").toLowerCase() }));
        if (meta.type === "password" || meta.ac.includes("one-time-code") || meta.ac.includes("password") || meta.ac.startsWith("cc-")) {
          return { ok: false, headline: `"${name}" is a secret field`, reason: "The probe never types into password, code or card fields." };
        }
        typed = await fakeValue(locator!, step.value, options.secrets());
        await liveAction(page, `Typing into '${name}'`, locator!);
        await locator!.fill(typed, { timeout: FIND_TIMEOUT_MS });
        break;
      }
      case "select": {
        await liveAction(page, `Choosing '${step.value ?? ""}' in '${name}'`, locator!);
        const value = step.value ?? "";
        await locator!.selectOption({ label: value }, { timeout: FIND_TIMEOUT_MS }).catch(() => locator!.selectOption(value, { timeout: FIND_TIMEOUT_MS }));
        typed = value;
        break;
      }
      case "upload": {
        const isFileInput = await locator!.evaluate((el) => el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "file");
        await liveAction(page, `Uploading a test file to '${name}'`, locator!);
        if (isFileInput) {
          const file = uploadFile(options.workDir, (await locator!.getAttribute("accept")) ?? "");
          await locator!.setInputFiles(file, { timeout: FIND_TIMEOUT_MS });
        } else {
          const chooser = page.waitForEvent("filechooser", { timeout: FIND_TIMEOUT_MS });
          await locator!.click({ timeout: FIND_TIMEOUT_MS });
          const fc = await chooser;
          const accept = (await fc.element().getAttribute("accept")) ?? "";
          await fc.setFiles(uploadFile(options.workDir, accept));
        }
        break;
      }
    }
  } catch (error) {
    const first = redact((error as Error).message.split("\n")[0], options.secrets());
    const blockedNow = blockedCount(session.blocked) > before.blocked;
    if (blockedNow) return { ok: false, headline: READ_ONLY_SKIP, reason: READ_ONLY_SKIP };
    return { ok: false, headline: `Could not ${step.action} "${name}" on ${where}`, reason: first };
  }

  if (step.action === "navigate" && status !== null && status >= 400) {
    return { ok: false, headline: `${step.path} answered ${status}`, reason: `Opening ${step.path} returned HTTP ${status}.` };
  }

  const ok = await checkOutcome(options, step, before, downloadsBefore, typed, locator);
  if (ok === true) return { ok: true };

  // The guard blocked a write while the step ran: off the allow-list that is a skip, not a failure.
  if (blockedCount(session.blocked) > before.blocked) return { ok: false, headline: READ_ONLY_SKIP, reason: READ_ONLY_SKIP };

  const clickish = step.action === "click" || step.action === "download";
  if (clickish && !(await changed(session, before))) {
    return { ok: false, headline: `${DEAD_BUTTON}: "${name}" on ${where}`, reason: `${DEAD_BUTTON}. No URL change, no page change, no request, no dialog and no download within ${CHANGE_WINDOW_MS / 1000} s of the click.` };
  }
  return { ok: false, headline: ok.headline, reason: ok.reason };
}

async function checkOutcome(
  options: ExecuteOptions,
  step: ProbeStep,
  before: Marks,
  downloadsBefore: number,
  typed: string | null,
  locator: Locator | null,
): Promise<true | { headline: string; reason: string }> {
  const { session } = options;
  const { page, watch } = session;
  const name = redact(targetName(step), options.secrets());
  const after = step.action === "navigate" ? `opening ${step.path}` : `using "${name}"`;
  const timeout = step.expect === "something_changes" ? CHANGE_WINDOW_MS : OUTCOME_TIMEOUT_MS;
  const fail = (headline: string, reason: string) => ({ headline, reason });

  switch (step.expect) {
    case "url_changes":
      if (await until(async () => page.url() !== before.url, timeout)) return true;
      return fail(`"${name}" did not change the page`, `The URL stayed ${pathOf(page)}.`);
    case "url_matches": {
      const pattern = step.expectPattern ?? "";
      if (await until(async () => pathOf(page).includes(pattern) || page.url().includes(pattern), timeout)) return true;
      return fail(`${after[0].toUpperCase()}${after.slice(1)} did not lead to ${pattern}`, `The URL is ${pathOf(page)}.`);
    }
    case "element_appears": {
      const target = step.expectRole && step.expectName
        ? page.getByRole(step.expectRole as Parameters<Page["getByRole"]>[0], { name: step.expectName })
        : page.getByText(step.expectText ?? "", { exact: false });
      const label = step.expectName ?? step.expectText ?? "";
      if (await until(async () => target.first().isVisible(), timeout)) return true;
      return fail(`"${label}" did not appear after ${after}`, `Waited ${timeout / 1000} s for ${step.expectRole ?? "text"} "${label}".`);
    }
    case "text_appears": {
      const text = step.expectText ?? "";
      if (await until(async () => page.getByText(text, { exact: false }).first().isVisible(), timeout)) return true;
      return fail(`"${text}" did not appear after ${after}`, `Waited ${timeout / 1000} s for the text.`);
    }
    case "dialog_opens":
      if (await until(async () => watch.dialogs > before.dialogs || (await page.locator(DIALOGS).count()) > before.openDialogs, timeout)) return true;
      return fail(`"${name}" did not open a dialog`, `No dialog within ${timeout / 1000} s.`);
    case "download_arrives": {
      if (!(await until(async () => watch.downloads.length > downloadsBefore, Math.max(timeout, 10_000)))) {
        return fail(`"${name}" did not download a file`, "No download started.");
      }
      const download = watch.downloads[watch.downloads.length - 1];
      const file = await download.path().catch(() => null);
      const failure = await download.failure().catch(() => "unknown");
      const filename = download.suggestedFilename();
      if (!file || failure) return fail(`"${name}" did not download a file`, `The download of ${filename} failed${failure ? `: ${failure}` : ""}.`);
      const size = statSync(file).size;
      if (size === 0) return fail(`"${name}" downloaded an empty file`, `${filename} has 0 bytes.`);
      const ext = (step.extension ?? "").replace(/^\./, "").toLowerCase();
      if (ext && !filename.toLowerCase().endsWith(`.${ext}`)) return fail(`"${name}" downloaded ${filename}, not a .${ext} file`, `${filename}, ${size} bytes.`);
      options.log(`     download arrived: ${filename}, ${size} bytes`);
      return true;
    }
    case "value_persists": {
      if (!locator || typed === null) return true;
      await locator.blur().catch(() => {});
      await settle(page);
      const kept = await until(async () => {
        if (step.action === "select") {
          const label = await locator.evaluate((el) => (el as HTMLSelectElement).selectedOptions?.[0]?.label ?? "");
          const value = await locator.inputValue();
          return label === typed || value === typed;
        }
        return (await locator.inputValue()) === typed;
      }, 1500);
      if (kept) return true;
      return fail(`"${name}" did not keep the value typed into it`, "The field was empty or different after leaving it.");
    }
    case "something_changes":
    default:
      if (await until(() => changed(session, before), timeout)) return true;
      return fail(`Nothing changed after ${after}`, `No URL change, page change, request, dialog or download within ${timeout / 1000} s.`);
  }
}

async function openStart(options: ExecuteOptions, start: string): Promise<void> {
  const { page } = options.session;
  await liveAction(page, `Opening ${start}`);
  await page.goto(start, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await settle(page);
  if (await signInIfAsked(options)) {
    // Signed in; go back to where the journey starts, unless that was the sign-in page itself.
    if (!(await isSignInScreen(page)) && pathOf(page) !== start) {
      await page.goto(start, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
      await settle(page);
    }
  }
}

/** One attempt at one journey. Returns the result and the journey as it should be recorded. */
async function attempt(options: ExecuteOptions, journey: ProbeJourney): Promise<{ result: JourneyResult; recorded: ProbeJourney | null }> {
  const started = Date.now();
  const steps: StepResult[] = [];
  const kept: ProbeStep[] = [];
  let headline: string | null = null;
  let failedStep: string | null = null;
  let skipped = false;

  try {
    await openStart(options, journey.start);
  } catch (error) {
    const reason = redact((error as Error).message.split("\n")[0], options.secrets());
    return {
      result: {
        name: journey.name, start: journey.start, outcome: "failed", headline: `${journey.start} did not load`, failedStep: `Open ${journey.start}`,
        steps: journey.steps.map((s, i) => ({ title: s.title, action: s.action, expect: s.expect, status: i === 0 ? "failed" : "not-run", reason: i === 0 ? reason : null, durationMs: 0 })),
        durationMs: Date.now() - started,
      },
      recorded: options.calibrate ? null : journey,
    };
  }

  for (let i = 0; i < journey.steps.length; i++) {
    const step: ProbeStep = { ...journey.steps[i] };
    if (headline || skipped) {
      steps.push({ title: step.title, action: step.action, expect: step.expect, status: "not-run", reason: skipped ? "An earlier step was skipped." : null, durationMs: 0 });
      kept.push(step);
      continue;
    }
    await signInIfAsked(options);
    const stepStarted = Date.now();
    options.log(`   ${i + 1}. ${step.title}`);
    let outcome = await runStep(options, step);

    if (!outcome.ok && options.calibrate) {
      if (outcome.elementMissing) {
        options.notes.push(`Planning: "${journey.name}" step "${step.title}" was dropped, its element was not on the page.`);
        options.log(`      dropped from the plan: ${outcome.reason}`);
        break; // the rest of this journey depended on it
      }
      const relaxable = (step.action === "click" || step.action === "navigate") && !["download_arrives", "something_changes"].includes(step.expect);
      if (relaxable && outcome.headline !== READ_ONLY_SKIP && !outcome.headline.startsWith(DEAD_BUTTON)) {
        options.log(`      kept as "something changes": the predicted outcome did not fit (${outcome.headline})`);
        step.relaxedFrom = step.expect;
        step.expect = "something_changes";
        outcome = { ok: true };
      }
    }

    const durationMs = Date.now() - stepStarted;
    kept.push(step);
    if (outcome.ok) {
      steps.push({ title: step.title, action: step.action, expect: step.expect, status: "passed", reason: null, durationMs });
    } else if (outcome.headline === READ_ONLY_SKIP) {
      skipped = true;
      options.log(`      skipped: ${READ_ONLY_SKIP}`);
      steps.push({ title: step.title, action: step.action, expect: step.expect, status: "skipped", reason: `Skipped: ${READ_ONLY_SKIP}.`, durationMs });
    } else {
      headline = outcome.headline;
      failedStep = step.title;
      options.log(`      FAILED: ${outcome.headline}`);
      steps.push({ title: step.title, action: step.action, expect: step.expect, status: "failed", reason: outcome.reason, durationMs });
    }
  }

  // Planning run: a journey with nothing left in it is not recorded and not reported.
  if (options.calibrate && kept.length === 0) return { result: { name: journey.name, start: journey.start, outcome: "skipped", headline: null, failedStep: null, steps: [], durationMs: Date.now() - started }, recorded: null };
  const passedAny = steps.some((s) => s.status === "passed");
  const outcome: JourneyResult["outcome"] = headline ? "failed" : skipped && !passedAny ? "skipped" : "passed";
  return {
    result: { name: journey.name, start: journey.start, outcome, headline, failedStep, steps, durationMs: Date.now() - started },
    recorded: { ...journey, steps: kept },
  };
}

export async function runJourneys(options: ExecuteOptions, journeys: ProbeJourney[]): Promise<{ results: JourneyResult[]; recorded: ProbeJourney[] }> {
  const results: JourneyResult[] = [];
  const recorded: ProbeJourney[] = [];
  for (const [index, journey] of journeys.entries()) {
    options.log(`• Journey ${index + 1}/${journeys.length}: ${journey.name} (from ${journey.start})`);
    await say(`Journey ${index + 1} of ${journeys.length}: ${journey.name}.`, "step");
    let run = await attempt(options, journey);
    if (run.result.outcome === "failed") {
      options.log("   failed, running it once more before reporting it");
      const again = await attempt(options, run.recorded ?? journey);
      if (again.result.outcome !== "failed") {
        run = { result: { ...again.result, outcome: "flaky" }, recorded: again.recorded };
      } else {
        run = again;
      }
    }
    if (options.calibrate && !run.recorded) continue;
    results.push(run.result);
    if (run.recorded) recorded.push(run.recorded);
    const r = run.result;
    await say(r.outcome === "failed" ? `${journey.name}: failed. ${r.headline}.` : `${journey.name}: ${r.outcome}.`, "step");
  }
  return { results, recorded };
}
