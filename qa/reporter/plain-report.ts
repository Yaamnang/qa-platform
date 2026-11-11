import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestError, TestResult, TestStep } from "@playwright/test/reporter";
import { secretsToRedact } from "../explore/redact";
import { config, ROOT } from "../lib/config";

/**
 * Turns Playwright results into a report a product manager can act on:
 * what broke, for which user journey, at which step, with what evidence.
 * Failures with the same root cause are grouped into one problem so a single
 * bug never shows up as a wall of red. Writes report.md and summary.json.
 */

export type Outcome = "passed" | "failed" | "flaky" | "skipped";

export type TestEntry = {
  id: string;
  journey: string;
  area: string;
  severity: "critical" | "high" | "medium";
  outcome: Outcome;
  durationMs: number;
  steps: { title: string; failed: boolean }[];
  failedStep: string | null;
  errors: string[];
  guard: string[];
  warnings: string[];
  notes: string[];
  evidence: { screenshot?: string; trace?: string; timeline?: string };
};

export type Problem = {
  headline: string;
  details: string[];
  area: string;
  severity: TestEntry["severity"];
  failedStep: string | null;
  tests: string[];
  evidence: TestEntry["evidence"];
  triage?: string;
  /** The page when it failed: images/<n>.png in the run folder, n being this problem's number. Absent when there is none. */
  image?: ProblemImage;
  /** Why there is no image, when there is none. */
  imageNote?: string;
};

/** path is relative to the run folder, for example images/1.png. */
export type ProblemImage = { n: number; path: string };

/** Tests that switch screenshots off because they type passwords and one-time codes. */
const NO_CAPTURE_FILES = new Set(["auth.setup.ts", "auth.spec.ts", "roles.spec.ts", "signup.spec.ts"]);
export const NO_IMAGE_SIGN_IN = "No image (sign-in steps are never captured)";

export type Summary = {
  runId: string;
  verdict: "PASS" | "FAIL" | "ENVIRONMENT UNAVAILABLE" | "SAFETY STOP";
  baseURL: string;
  target: string;
  environment: Record<string, unknown> | null;
  startedAt: string;
  durationMs: number;
  counts: Record<Outcome, number>;
  problems: Problem[];
  notRun: string | null;
  warnings: { test: string; message: string }[];
  flaky: string[];
  globalErrors: string[];
  tests: TestEntry[];
};

const AREAS: Record<string, string> = {
  "@auth": "Sign-in",
  "@documents": "Documents",
  "@ai-jobs": "AI jobs",
  "@settings": "Settings",
  "@team": "Team",
  "@roles": "Roles and permissions",
  "@security": "Security / tenant isolation",
};

const ANSI = /\u001b\[[0-9;]*m/g;

/** Read fresh each time, so a login, key or code shared later in the run is cut too. */
function redact(s: string): string {
  let out = s;
  for (const secret of secretsToRedact()) out = out.split(secret).join("[REDACTED]");
  return out;
}

function clean(error: TestError): string {
  return redact((error.message ?? error.value ?? "Unknown error").replace(ANSI, ""));
}

/** First meaningful line of a Playwright error, minus framework noise. */
export function headlineOf(message: string): string {
  const first = message.split("\n").map((l) => l.trim()).find(Boolean) ?? message;
  return first.replace(/^Error:\s*/, "").replace(/^\[\w+\]\s*/, "");
}

/** One line per failed check: "<what should be true>: expected X, got Y". */
export function describeError(message: string): string {
  const headline = headlineOf(message);
  const lines = message.split("\n").map((l) => l.trim());
  const pick = (re: RegExp) => lines.find((l) => re.test(l))?.replace(/^[^:]*:\s*/, "");
  const expected = pick(/^Expected( string| value| pattern)?:/);
  let received = pick(/^Received( string| value)?:/);
  if (!received && /element\(s\) not found/.test(message)) received = "nothing on the page (element not found)";
  const locator = pick(/^Locator:/);
  const what = /^expect\(/.test(headline) && locator ? `Check on ${locator}` : headline;
  return expected || received ? `${what}: expected ${expected ?? "?"}, got ${received ?? "?"}` : what;
}

const rel = (p?: string) => (p ? path.relative(ROOT, p).replace(/\\/g, "/") : undefined);

class PlainReport implements Reporter {
  private started = Date.now();
  private latest = new Map<string, { test: TestCase; result: TestResult }>();
  private globalErrors: string[] = [];
  private allTests: TestCase[] = [];

  onBegin(_config: FullConfig, suite: Suite) {
    // Tests blocked by a failed dependency (e.g. sign-in) never get a result,
    // so collect the full list up front to report them as "not run".
    this.allTests = suite.allTests();
  }

  onError(error: TestError) {
    this.globalErrors.push(headlineOf(clean(error)));
  }

  onTestEnd(test: TestCase, result: TestResult) {
    this.latest.set(test.id, { test, result });
  }

  private notRunEntry(test: TestCase): TestEntry {
    const areaTag = test.tags.find((t) => t in AREAS);
    return {
      id: test.id,
      journey: test.titlePath().slice(3).join(" › ") || test.title,
      area: areaTag ? AREAS[areaTag] : "General",
      severity: "high",
      outcome: "skipped",
      durationMs: 0,
      steps: [],
      failedStep: null,
      errors: [],
      guard: [],
      warnings: [],
      notes: [],
      evidence: {},
    };
  }

  private entry(test: TestCase, result: TestResult): TestEntry {
    const tags = test.tags;
    const areaTag = tags.find((t) => t in AREAS);
    const allAnn = [...test.annotations, ...result.annotations];
    const guard = allAnn.filter((a) => a.type === "guard").map((a) => redact(a.description ?? ""));
    const outcomeRaw = test.outcome();
    const outcome: Outcome =
      outcomeRaw === "expected" ? "passed" : outcomeRaw === "flaky" ? "flaky" : outcomeRaw === "skipped" ? "skipped" : "failed";

    const steps = result.steps
      .filter((s: TestStep) => s.category === "test.step")
      .map((s) => ({ title: s.title, failed: !!s.error }));
    const att = (name: string) => rel(result.attachments.find((a) => a.name === name)?.path);
    const critical =
      [...guard, ...result.errors.map((e) => headlineOf(clean(e)))].some((m) => /CRITICAL|SAFETY/.test(m)) || tags.includes("@security");

    return {
      id: test.id,
      journey: test.titlePath().slice(3).join(" › ") || test.title,
      area: guard.some((g) => g.startsWith("CRITICAL")) ? AREAS["@security"] : areaTag ? AREAS[areaTag] : "General",
      severity: critical ? "critical" : tags.includes("@settings") ? "medium" : "high",
      outcome,
      durationMs: result.duration,
      steps,
      failedStep: steps.find((s) => s.failed)?.title ?? null,
      errors: result.errors.map(clean),
      guard,
      warnings: allAnn.filter((a) => a.type === "warning").map((a) => redact(a.description ?? "")),
      notes: allAnn.filter((a) => a.type === "info").map((a) => redact(a.description ?? "")),
      evidence: { screenshot: att("screenshot"), trace: att("trace"), timeline: att("job-timeline.json") },
    };
  }

  onEnd(full: FullResult) {
    const tests = this.allTests.map((test) => {
      const ran = this.latest.get(test.id);
      return ran ? this.entry(ran.test, ran.result) : this.notRunEntry(test);
    });
    const counts: Record<Outcome, number> = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
    for (const t of tests) counts[t.outcome]++;

    // Group failures by root cause. Guard findings (crash, leak, safety) are
    // the most specific signal, so they win over the assertion that tripped later.
    const groups = new Map<string, Problem>();
    // Which test file each problem came from, to explain a missing image.
    const fileOf = new Map<Problem, string>();
    tests.forEach((t, index) => {
      if (t.outcome !== "failed") return;
      const primary = t.guard[0] ?? t.errors[0] ?? "Unknown failure";
      const headline = headlineOf(primary);
      const p = groups.get(headline);
      if (p) {
        p.tests.push(t.journey);
        return;
      }
      const details = [...new Set([...t.guard.slice(1), ...t.errors.map(describeError)])]
        .filter((d) => d !== headline)
        .map((d) => (d.startsWith(`${headline}: `) ? d.slice(headline.length + 2) : d));
      groups.set(headline, {
        headline,
        details: details.slice(0, 6),
        area: t.area,
        severity: t.severity,
        failedStep: t.failedStep,
        tests: [t.journey],
        evidence: t.evidence,
      });
      fileOf.set(groups.get(headline)!, path.basename(this.allTests[index].location.file));
    });
    const order = { critical: 0, high: 1, medium: 2 };
    const problems = [...groups.values()].sort((a, b) => order[a.severity] - order[b.severity]);
    problems.forEach((p, i) => numberImage(p, i + 1, fileOf.get(p) ?? ""));

    let environment: Record<string, unknown> | null = null;
    try {
      environment = JSON.parse(readFileSync(path.join(config.resultsDir, "environment.json"), "utf8"));
    } catch {}

    const setup = tests.find((t) => t.journey.includes("sign in as the QA bot") && t.outcome === "failed");
    const stoppedForSafety = !!setup && [...setup.guard, ...setup.errors].some((m) => /CRITICAL|SAFETY/.test(m));
    const notRun =
      counts.skipped && setup
        ? stoppedForSafety
          ? `${counts.skipped} test(s) were not run: the run was stopped for safety right after sign-in (see problem 1).`
          : `${counts.skipped} test(s) were not run because the QA bot could not sign in. Fix sign-in first.`
        : null;

    const safetyStop = [...this.globalErrors, ...problems.map((p) => p.headline)].some((e) => e.startsWith("SAFETY STOP"));
    const envDown = this.globalErrors.some((e) => e.startsWith("ENVIRONMENT UNAVAILABLE"));
    const verdict: Summary["verdict"] = safetyStop
      ? "SAFETY STOP"
      : envDown
        ? "ENVIRONMENT UNAVAILABLE"
        : counts.failed > 0 || full.status !== "passed" || tests.length === 0
          ? "FAIL"
          : "PASS";

    const summary: Summary = {
      runId: config.runId,
      verdict,
      baseURL: config.baseURL,
      target: config.target,
      environment,
      startedAt: new Date(this.started).toISOString(),
      durationMs: Date.now() - this.started,
      counts,
      problems,
      notRun,
      warnings: tests.flatMap((t) => t.warnings.map((m) => ({ test: t.journey, message: m }))),
      flaky: tests.filter((t) => t.outcome === "flaky").map((t) => t.journey),
      globalErrors: this.globalErrors,
      tests,
    };

    mkdirSync(config.resultsDir, { recursive: true });
    writeFileSync(path.join(config.resultsDir, "summary.json"), JSON.stringify(summary, null, 2));
    writeFileSync(path.join(config.resultsDir, "report.md"), renderMarkdown(summary));
  }

  printsToStdio() {
    return false;
  }
}

/**
 * Copies the screenshot Playwright took when the problem's first test failed
 * to images/<n>.png, n being the problem's number in the report. Kept as PNG:
 * converting would need a new dependency. Nothing is copied for a passing run,
 * so a clean run has no images folder.
 */
function numberImage(p: Problem, n: number, file: string): void {
  const shot = p.evidence.screenshot ? path.resolve(ROOT, p.evidence.screenshot) : null;
  if (!shot || !existsSync(shot)) {
    p.imageNote = NO_CAPTURE_FILES.has(file) ? NO_IMAGE_SIGN_IN : "No image";
    return;
  }
  try {
    const dir = path.join(config.resultsDir, "images");
    mkdirSync(dir, { recursive: true });
    copyFileSync(shot, path.join(dir, `${n}.png`));
    p.image = { n, path: `images/${n}.png` };
  } catch {
    p.imageNote = "No image";
  }
}

/** "(Image 1)" for a log line, or nothing. */
export function imageTag(p: Pick<Problem, "image">): string {
  return p.image ? ` (Image ${p.image.n})` : "";
}

export function renderMarkdown(s: Summary): string {
  const icon = s.verdict === "PASS" ? "✅" : "❌";
  const L: string[] = [];
  L.push(`# QA report: ${icon} ${s.verdict}`);
  L.push("");
  L.push(`- **Run:** \`${s.runId}\` · started ${s.startedAt} · took ${Math.round(s.durationMs / 1000)}s`);
  L.push(`- **Target:** ${s.baseURL} (${s.target})${s.environment ? ` · AI mode: ${s.environment.aiMode}` : ""}`);
  L.push(`- **Checks:** ${s.counts.passed} passed · ${s.counts.failed} failed · ${s.counts.flaky} flaky · ${s.counts.skipped} not run`);
  L.push("");

  if (s.globalErrors.length) {
    L.push("## Run could not start", "");
    for (const e of s.globalErrors) L.push(`- ${e}`);
    L.push("");
  }

  if (s.problems.length) {
    L.push(`## What broke (${s.problems.length} problem${s.problems.length > 1 ? "s" : ""})`, "");
    s.problems.forEach((p, i) => {
      L.push(`### ${i + 1}. [${p.severity.toUpperCase()}] ${p.area}: ${p.headline}`, "");
      L.push(`- **User journey:** ${p.tests[0]}${p.tests.length > 1 ? ` (+${p.tests.length - 1} more affected: ${p.tests.slice(1).join("; ")})` : ""}`);
      if (p.failedStep) L.push(`- **Step that failed:** ${p.failedStep}`);
      for (const d of p.details) L.push(`- ${d}`);
      if (p.image) L.push(`- **Image:** [Image ${p.image.n}](${p.image.path})`);
      else if (p.imageNote) L.push(`- **Image:** ${p.imageNote}`);
      const ev = [
        p.evidence.screenshot && `[screenshot](${p.evidence.screenshot})`,
        p.evidence.timeline && `[job timeline](${p.evidence.timeline})`,
        p.evidence.trace && `trace: \`npx playwright show-trace ${p.evidence.trace}\``,
      ].filter(Boolean);
      if (ev.length) L.push(`- **Evidence:** ${ev.join(" · ")}`);
      if (p.triage) L.push(`- **AI triage (advisory):** ${p.triage}`);
      L.push("");
    });
  }
  if (s.notRun) L.push(`> ${s.notRun}`, "");

  if (s.flaky.length) {
    L.push("## Flaky (passed on retry; not counted as a failure, tracked for quarantine)", "");
    for (const f of s.flaky) L.push(`- ${f}`);
    L.push("");
  }
  if (s.warnings.length) {
    L.push("## Warnings (did not fail the run)", "");
    for (const w of s.warnings) L.push(`- ${w.test}: ${w.message}`);
    L.push("");
  }

  L.push("## All checks", "", "| Area | User journey | Result | Time |", "|---|---|---|---|");
  const mark = { passed: "✅ pass", failed: "❌ FAIL", flaky: "⚠️ flaky", skipped: "⏭️ not run" };
  for (const t of s.tests) {
    L.push(`| ${t.area} | ${t.journey} | ${mark[t.outcome]} | ${(t.durationMs / 1000).toFixed(1)}s |`);
  }
  const notes = s.tests.flatMap((t) => t.notes);
  if (notes.length) {
    L.push("", "## Notes", "");
    for (const n of notes) L.push(`- ${n}`);
  }
  L.push("");
  return L.join("\n");
}

export default PlainReport;
