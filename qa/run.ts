/**
 * One command to run the QA system.
 *
 *   npm run qa                         build + start the stand-in, run everything, report
 *   npm run qa -- --bugs job-stuck     same, with an injected regression
 *   npm run qa:repeat                  run 10 times with nothing changed; prove identical results
 *   npm run qa:bugs                    run once per injected bug; prove each one is caught
 *   npm run qa -- --target https://staging.example.com     test an existing deployment
 *                                      (credentials from QA_EMAIL / QA_PASSWORD / QA_TOTP_SECRET, and
 *                                      optionally QA_VIEWER_EMAIL / _PASSWORD / _TOTP_SECRET for the role tests)
 *
 * Exit code: 0 = PASS, 1 = FAIL, 2 = environment unavailable / safety stop, 3 = runner error.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { BUG_CATALOG, MUST_STILL_PASS, type BugId } from "../lib/bug-catalog";
import { imageTag, renderMarkdown, type Summary } from "./reporter/plain-report";
import { linked, say } from "./lib/console-link";
import { newTotpSecret } from "./lib/totp";
import { triageProblems } from "./lib/triage";

const ROOT = process.cwd();
const NEXT_BIN = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
const PW_CLI = path.join(ROOT, "node_modules", "@playwright", "test", "cli.js");

const { values: args } = parseArgs({
  options: {
    "base-url": { type: "string" },
    target: { type: "string" }, // alias of --base-url
    bugs: { type: "string", default: "" },
    "ai-mode": { type: "string", default: process.env.AI_MODE ?? "mock" },
    repeat: { type: "string", default: "1" },
    "bug-matrix": { type: "boolean", default: false },
    grep: { type: "string" },
    port: { type: "string", default: process.env.QA_PORT ?? "3100" },
    quiet: { type: "boolean", default: false },
  },
});

type Account = { email: string; password: string; totpSecret: string };
/** The QA bot (Admin of the QA org) plus a second, read-only Viewer account in the same org. */
type Creds = Account & { viewer: Account };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const log = (...lines: string[]) => process.stdout.write((lines.length ? lines : [""]).join("\n") + "\n");
const newRunId = () => `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}-${randomBytes(2).toString("hex")}`;

function ensureBrowser() {
  const r = spawnSync(process.execPath, [PW_CLI, "install", "chromium"], { stdio: ["ignore", "pipe", "inherit"] });
  if (r.status !== 0) throw new Error("Could not install the Playwright Chromium browser.");
}

function newestMtime(p: string): number {
  if (!existsSync(p)) return 0;
  const st = statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  return Math.max(0, ...readdirSync(p).map((f) => newestMtime(path.join(p, f))));
}

function ensureBuild() {
  const buildId = path.join(ROOT, ".next", "BUILD_ID");
  const sources = ["app", "lib", "components", "next.config.ts", "package.json"].map((p) => newestMtime(path.join(ROOT, p)));
  if (existsSync(buildId) && statSync(buildId).mtimeMs > Math.max(...sources)) return;
  log("• Building the stand-in platform (next build)…");
  const r = spawnSync(process.execPath, [NEXT_BIN, "build"], { stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
  if (r.status !== 0) throw new Error("next build failed");
}

async function healthy(baseURL: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * What a deployed target says about itself at GET /api/health: whether it is
 * a stand-in (a test copy of the platform, see qa/probe/detect.ts) and where
 * its sign-in page is. Anything unexpected counts as an ordinary site.
 */
async function targetInfo(baseURL: string): Promise<{ standIn: boolean; signInPath?: string }> {
  try {
    const res = await fetch(new URL("/api/health", baseURL), { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { standIn: false };
    const body = (await res.json()) as { standIn?: unknown; signInPath?: unknown };
    const signInPath = typeof body.signInPath === "string" && body.signInPath.startsWith("/") ? body.signInPath : undefined;
    return { standIn: body.standIn === true, signInPath };
  } catch {
    return { standIn: false };
  }
}

async function startServer(port: number, bugs: string, aiMode: string, creds: Creds, label: string): Promise<ChildProcess> {
  const baseURL = `http://localhost:${port}`;
  if (await healthy(baseURL)) {
    throw new Error(`Port ${port} is already serving something. Stop it or pass --port.`);
  }
  mkdirSync(path.join(ROOT, "qa-results"), { recursive: true });
  const logFile = createWriteStream(path.join(ROOT, "qa-results", `server-${label}.log`));
  const child = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(port)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      BUGS: bugs,
      AI_MODE: aiMode,
      JOB_STAGE_MS: process.env.JOB_STAGE_MS ?? "5000", // fake AI job takes ~20s, like a real one
      INSECURE_COOKIES: "1", // plain http on localhost
      SEED_QA_EMAIL: creds.email,
      SEED_QA_PASSWORD: creds.password,
      SEED_QA_TOTP_SECRET: creds.totpSecret,
      SEED_QA_VIEWER_EMAIL: creds.viewer.email,
      SEED_QA_VIEWER_PASSWORD: creds.viewer.password,
      SEED_QA_VIEWER_TOTP_SECRET: creds.viewer.totpSecret,
    },
  });
  child.stdout!.pipe(logFile);
  child.stderr!.pipe(logFile);

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The stand-in exited early (see qa-results/server-${label}.log)`);
    if (await healthy(baseURL)) return child;
    await new Promise((r) => setTimeout(r, 300));
  }
  child.kill();
  throw new Error("The stand-in did not become healthy within 60s");
}

async function stopServer(child: ChildProcess | null) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
}

async function runSuite(opts: { baseURL: string; creds: Creds; target: string; quiet: boolean; signInPath?: string }): Promise<Summary> {
  const runId = newRunId();
  const resultsDir = path.join("qa-results", runId);
  const env = {
    ...process.env,
    QA_RUN_ID: runId,
    QA_RESULTS_DIR: resultsDir,
    QA_BASE_URL: opts.baseURL,
    QA_TARGET: opts.target,
    QA_EMAIL: opts.creds.email,
    QA_PASSWORD: opts.creds.password,
    QA_TOTP_SECRET: opts.creds.totpSecret,
    QA_VIEWER_EMAIL: opts.creds.viewer.email,
    QA_VIEWER_PASSWORD: opts.creds.viewer.password,
    QA_VIEWER_TOTP_SECRET: opts.creds.viewer.totpSecret,
    QA_ALLOWED_HOSTS: process.env.QA_ALLOWED_HOSTS ?? `localhost,127.0.0.1,${new URL(opts.baseURL).hostname}`,
    // The target's own sign-in page, unless the environment names one.
    ...(opts.signInPath && !process.env.QA_SIGNIN_PATH ? { QA_SIGNIN_PATH: opts.signInPath } : {}),
    ...(args.grep ? { QA_GREP: args.grep } : {}),
  };
  const pwArgs = [PW_CLI, "test", "--config", path.join("qa", "playwright.config.ts")];
  if (args.grep) pwArgs.push("--grep", args.grep);

  await new Promise<void>((resolve) => {
    const child = spawn(process.execPath, pwArgs, { cwd: ROOT, env, stdio: opts.quiet ? "ignore" : "inherit" });
    child.on("exit", () => resolve());
  });

  const summaryPath = path.join(ROOT, resultsDir, "summary.json");
  if (!existsSync(summaryPath)) throw new Error(`The test run produced no summary (${summaryPath}).`);
  const summary: Summary = JSON.parse(readFileSync(summaryPath, "utf8"));

  if (summary.problems.length && (await triageProblems(summary.problems))) {
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    writeFileSync(path.join(ROOT, resultsDir, "report.md"), renderMarkdown(summary));
  }

  const latest = path.join(ROOT, "qa-results", "latest");
  rmSync(latest, { recursive: true, force: true });
  cpSync(path.join(ROOT, resultsDir), latest, { recursive: true });
  return summary;
}

function printSummary(s: Summary) {
  const bar = "═".repeat(72);
  const icon = s.verdict === "PASS" ? "✅" : "❌";
  const c = s.counts;
  log("", bar);
  log(` QA RESULT: ${icon} ${s.verdict}   ${c.passed} passed · ${c.failed} failed · ${c.flaky} flaky · ${c.skipped} not run · ${Math.round(s.durationMs / 1000)}s`);
  log(bar);
  for (const e of s.globalErrors) log(` ! ${e}`);
  s.problems.forEach((p, i) => {
    log(` ${i + 1}. [${p.severity.toUpperCase()}] ${p.area}: ${p.headline}${imageTag(p)}`);
    log(`    Journey: ${p.tests[0]}${p.tests.length > 1 ? ` (+${p.tests.length - 1} more)` : ""}`);
    if (p.failedStep) log(`    Step:    ${p.failedStep}`);
    for (const d of p.details.slice(0, 3)) log(`    ${d}`);
    if (p.triage) log(`    AI triage: ${p.triage}`);
  });
  if (s.notRun) log(` ${s.notRun}`);
  if (s.warnings.length) log(` ${s.warnings.length} warning(s), see report.`);
  log(` Report: qa-results/${s.runId}/report.md   (also qa-results/latest/report.md)`);
  log(` HTML:   npx playwright show-report qa-results/${s.runId}/html`);
  log(bar, "");
}

/** One line for the console's job chat. Built from the summary, so it says exactly what the report says. */
function verdictNote(s: Summary): string {
  const c = s.counts;
  const counts = `${c.passed} passed, ${c.failed} failed, ${c.flaky} flaky, ${c.skipped} not run`;
  if (s.verdict === "PASS") return `Verdict PASS: ${counts}.`;
  if (s.verdict === "FAIL") return `Verdict FAIL: ${counts}. First problem: ${s.problems[0]?.headline ?? "see the report"}.`;
  return `Verdict ${s.verdict}: ${s.globalErrors[0] ?? "no tests were run"}.`;
}

const exitCodeFor = (s: Summary) => (s.verdict === "PASS" ? 0 : s.verdict === "FAIL" ? 1 : 2);

/** Same tests with the same outcomes → same signature. */
function signature(s: Summary): string {
  const outcomes = s.tests.map((t) => `${t.journey}=${t.outcome}`).sort().join("\n");
  return createHash("sha256").update(`${s.verdict}\n${outcomes}`).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const external = args.target ?? args["base-url"];
  const port = Number(args.port);
  const baseURL = external ?? `http://localhost:${port}`;
  // A deployed stand-in (its /api/health says standIn) is a test copy like the
  // local one, so every test runs, sign-up included: target "stand-in". Any
  // other deployment is "staging" unless QA_TARGET says otherwise.
  const info = external ? await targetInfo(baseURL) : { standIn: false };
  const target = process.env.QA_TARGET ?? (external ? (info.standIn ? "stand-in" : "staging") : "local");
  const signInPath = "signInPath" in info ? info.signInPath : undefined;

  // Fresh throw-away credentials for every local run: nothing to leak, nothing to commit.
  const throwAway = (email: string): Account => ({ email, password: randomBytes(18).toString("base64url"), totpSecret: newTotpSecret() });
  const creds: Creds = external
    ? {
        email: process.env.QA_EMAIL ?? "",
        password: process.env.QA_PASSWORD ?? "",
        totpSecret: process.env.QA_TOTP_SECRET ?? "",
        // Optional: without it the role tests are skipped, not failed.
        viewer: {
          email: process.env.QA_VIEWER_EMAIL ?? "",
          password: process.env.QA_VIEWER_PASSWORD ?? "",
          totpSecret: process.env.QA_VIEWER_TOTP_SECRET ?? "",
        },
      }
    : {
        ...throwAway("qa-bot@synthetic.eclypse.test"),
        viewer: throwAway("qa-viewer@synthetic.eclypse.test"),
      };
  if (external && (!creds.email || !creds.password || !creds.totpSecret)) {
    // Started from the QA console: the sign-in test asks the employee in the
    // job's chat when it reaches each screen (qa/tests/auth.setup.ts).
    if (!linked()) {
      log("QA_EMAIL, QA_PASSWORD and QA_TOTP_SECRET must be set to test an external deployment.");
      return 3;
    }
    log("• No saved QA login for this target. The run asks for it in the console when it reaches the sign-in screen.");
  }

  log("• Checking the Playwright browser…");
  ensureBrowser();
  if (!external) ensureBuild();

  // --- Bug matrix: one run per injected bug (plus a clean baseline) ---------
  if (args["bug-matrix"]) {
    if (external) throw new Error("--bug-matrix only works against the local stand-in");
    const cases: (BugId | "none")[] = ["none", ...(Object.keys(BUG_CATALOG) as BugId[])];
    const rows: { bug: string; description: string; asExpected: boolean; status: string; verdict: string; caughtBy: string; headline: string; runId: string }[] = [];
    for (const bug of cases) {
      log(`• Bug matrix: ${bug === "none" ? "baseline (no bugs)" : bug}…`);
      const server = await startServer(port, bug === "none" ? "" : bug, args["ai-mode"]!, creds, `bug-${bug}`);
      let s: Summary;
      try {
        s = await runSuite({ baseURL, creds, target, quiet: true });
      } finally {
        await stopServer(server);
      }
      const failing = s.tests.filter((t) => t.outcome === "failed").map((t) => t.journey);
      const mustPass = bug === "none" || MUST_STILL_PASS.includes(bug);
      const asExpected = mustPass ? s.verdict === "PASS" : s.verdict !== "PASS";
      rows.push({
        bug,
        description: bug === "none" ? "Baseline: nothing injected" : BUG_CATALOG[bug],
        asExpected,
        status: bug === "none"
          ? (asExpected ? "✅ clean" : "❌ baseline failed")
          : mustPass
            ? (asExpected ? "✅ passed (no false alarm)" : "❌ FALSE ALARM")
            : (asExpected ? "✅ caught" : "❌ MISSED"),
        verdict: s.verdict,
        caughtBy: failing.join("; ") || "(nothing failed)",
        headline: s.problems[0]?.headline ?? "",
        runId: s.runId,
      });
      log(`  → ${s.verdict}${s.problems[0] ? `: ${s.problems[0].headline}` : ""}`);
    }
    const bugRows = rows.filter((r) => r.bug !== "none" && !MUST_STILL_PASS.includes(r.bug as BugId));
    const passRows = rows.filter((r) => MUST_STILL_PASS.includes(r.bug as BugId));
    const caught = bugRows.filter((r) => r.asExpected).length;
    const quiet = passRows.filter((r) => r.asExpected).length;
    const md = [
      "# Bug matrix",
      "",
      `Generated ${new Date().toISOString()} · AI mode: ${args["ai-mode"]} · command: \`npm run qa:bugs\``,
      "",
      `**Baseline (no bugs): ${rows[0].verdict}** · **Bugs caught: ${caught}/${bugRows.length}** · **No false alarm on slow-but-working pages: ${quiet}/${passRows.length}** · retries: ${process.env.QA_RETRIES ?? 1}`,
      "",
      "| Injected problem | What it does | Result | Failing user journeys | Headline in the report |",
      "|---|---|---|---|---|",
      ...rows.map((r) =>
        `| \`${r.bug}\` | ${r.description} | ${r.status} | ${r.caughtBy.replace(/\|/g, "/")} | ${r.headline.replace(/\|/g, "/")} |`,
      ),
      "",
      "Each run's full report is in `qa-results/<run id>/report.md`:",
      "",
      ...rows.map((r) => `- \`${r.bug}\`: \`${r.runId}\``),
      "",
    ].join("\n");
    mkdirSync(path.join(ROOT, "results"), { recursive: true });
    writeFileSync(path.join(ROOT, "results", "bug-matrix.md"), md);
    log("", md);
    return rows.every((r) => r.asExpected) ? 0 : 1;
  }

  // --- Single run or repeated runs against one server ----------------------
  const repeat = Math.max(1, Number(args.repeat));
  const server = external ? null : await startServer(port, args.bugs!, args["ai-mode"]!, creds, "main");
  try {
    if (repeat === 1) {
      await say("Starting the probe. The browser opens the sign-in page first.", "start");
      const s = await runSuite({ baseURL, creds, target, quiet: args.quiet!, signInPath });
      printSummary(s);
      await say(verdictNote(s), "verdict");
      return exitCodeFor(s);
    }

    const runs: Summary[] = [];
    for (let i = 1; i <= repeat; i++) {
      log(`• Stability run ${i}/${repeat}…`);
      const s = await runSuite({ baseURL, creds, target, quiet: true, signInPath });
      runs.push(s);
      log(`  → ${s.verdict} (${s.counts.passed} passed, ${s.counts.failed} failed, ${s.counts.flaky} flaky) signature ${signature(s)}`);
    }
    const sigs = new Set(runs.map(signature));
    const identical = sigs.size === 1;
    const md = [
      `# Stability: ${repeat} runs with nothing changed`,
      "",
      `Generated ${new Date().toISOString()} · AI mode: ${args["ai-mode"]} · bugs injected: ${args.bugs || "none"} · retries: ${process.env.QA_RETRIES ?? 1} · command: \`npm run qa:repeat\``,
      "",
      `**Result: ${identical ? `✅ all ${repeat} runs gave the identical result` : `❌ results differed between runs (${sigs.size} distinct outcomes)`}**`,
      "",
      "Same server for all runs, so this also proves the suite cleans up after itself and leaves no state behind.",
      "",
      "| Run | Verdict | Passed | Failed | Flaky | Not run | Duration | Outcome signature |",
      "|---|---|---|---|---|---|---|---|",
      ...runs.map((s, i) => `| ${i + 1} | ${s.verdict} | ${s.counts.passed} | ${s.counts.failed} | ${s.counts.flaky} | ${s.counts.skipped} | ${Math.round(s.durationMs / 1000)}s | \`${signature(s)}\` |`),
      "",
    ].join("\n");
    mkdirSync(path.join(ROOT, "results"), { recursive: true });
    writeFileSync(path.join(ROOT, "results", "stability.md"), md);
    log("", md);
    return identical && runs.every((r) => r.verdict === runs[0].verdict) ? exitCodeFor(runs[0]) : 1;
  } finally {
    await stopServer(server);
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`QA runner error: ${(err as Error).message}`);
    process.exit(3);
  },
);
