/**
 * The Probe, for any website.
 *
 *   tsx qa/probe/run.ts --target https://example.com            pick the Probe for this target and run it
 *   tsx qa/probe/run.ts --target http://localhost:4000 --plan p.json   replay a recorded plan, no model
 *
 * Which Probe runs: when the target is our own stand-in (detect.ts), the
 * built-in suite in qa/run.ts runs exactly as before, with the same
 * arguments, and its exit code is passed on. Any other site gets the AI Probe:
 *
 *  1. A recorded plan (PROBE_PLAN_IN or --plan) is replayed with no model call.
 *     Otherwise Claude Haiku plans 3 to 6 journeys from a few screens (plan.ts).
 *     Neither a key nor a plan: stop with a clear message.
 *  2. execute.ts runs every step with Playwright and checks its outcome. The
 *     verdict comes only from those checks.
 *  3. After a planning run, the journeys as executed are written to
 *     PROBE_PLAN_OUT, which the console saves on the workspace.
 *
 * Read-only unless PROBE_WRITES_ALLOWED=1 (the console sets it for hosts on
 * CONSOLE_QA_HOSTS). Exit code: 0 PASS, 1 FAIL, 2 could not run, 3 runner error.
 * The last lines print "Report: qa-results/<run id>/report.md", which is how
 * the console finds summary.json.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathOf, settle, type Credentials } from "../explore/crawl";
import { redact, secretsToRedact } from "../explore/redact";
import { linked, say } from "../lib/console-link";
import { liveAction } from "../lib/live-view";
import { hasAnthropicKey, isStandIn, NO_KEY_NO_PLAN } from "./detect";
import { runJourneys } from "./execute";
import { approxCost, PlanError, planJourneys, PROBE_MODEL, samePath } from "./plan";
import { buildSummary, writeSummary } from "./report";
import { openProbeSession } from "./session";
import { readScreenOf, type Screen } from "./snapshot";
import type { ProbeInfo, ProbeJourney, ProbePlan } from "./types";

const ROOT = process.cwd();
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const log = (line = "") => process.stdout.write(`${line}\n`);

const { values: args } = parseArgs({
  options: {
    target: { type: "string" },
    "base-url": { type: "string" },
    plan: { type: "string" },
    headed: { type: "boolean", default: false },
  },
  strict: false,
});

/** Runs qa/run.ts with the same arguments. It never gets the model key: no model has a say in the built-in suite. */
function runBuiltInSuite(): Promise<number> {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(ANTHROPIC_|PROBE_)/.test(name)) delete env[name];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX_CLI, path.join("qa", "run.ts"), ...process.argv.slice(2)], { cwd: ROOT, env, stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 3));
    child.on("error", () => resolve(3));
  });
}

function readPlan(file: string | undefined, origin: string): ProbePlan | null {
  if (!file || !existsSync(file)) return null;
  try {
    const plan = JSON.parse(readFileSync(file, "utf8")) as ProbePlan;
    if (!Array.isArray(plan.journeys) || plan.journeys.length === 0) return null;
    if (plan.origin && plan.origin !== origin) {
      log(`• The recorded plan is for ${plan.origin}, not ${origin}. Ignoring it.`);
      return null;
    }
    return plan;
  } catch {
    log("• The recorded plan could not be read. Ignoring it.");
    return null;
  }
}

/** A few screens for the planner: where the visitor lands, after sign-in if asked, and up to three linked pages. */
async function lookAround(session: Awaited<ReturnType<typeof openProbeSession>>, origin: string): Promise<Screen[]> {
  const { page, gate } = session;
  const screens: Screen[] = [];
  const add = async () => {
    await settle(page);
    const screen = await readScreenOf(page);
    if (!screens.some((s) => s.path === screen.path)) screens.push(screen);
    return screen;
  };
  let first = await add();
  if (await gate.maybeSignIn(page)) first = await add();
  const links = first.controls
    .filter((c) => c.role === "link" && c.href && c.href !== "external" && !c.downloads)
    .map((c) => samePath(c.href!, origin))
    .filter((p): p is string => !!p && !screens.some((s) => s.path === p));
  for (const link of [...new Set(links)].slice(0, 3)) {
    try {
      await liveAction(page, `Opening ${link}`);
      await page.goto(link, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await settle(page);
      await gate.maybeSignIn(page);
      log(`     looked at ${pathOf(page)}`);
      await add();
    } catch {
      // A page that does not load is simply not planned from.
    }
  }
  return screens;
}

async function aiProbe(target: string): Promise<number> {
  const startedAt = new Date();
  const runId = `${startedAt.toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}-${randomBytes(2).toString("hex")}`;
  const origin = new URL(target).origin;
  const start = samePath(new URL(target).pathname || "/", origin) ?? "/";
  const readOnly = process.env.PROBE_WRITES_ALLOWED !== "1";
  const maxSteps = Number(process.env.PROBE_MAX_STEPS) || 40;
  const maxTokens = Number(process.env.PROBE_MAX_TOKENS) || 30_000;
  const workDir = process.env.PROBE_DIR || path.join(ROOT, "qa-results", runId);
  mkdirSync(workDir, { recursive: true });
  const notes: string[] = [];
  const credentials: Credentials = {
    email: process.env.QA_EMAIL ?? "",
    password: process.env.QA_PASSWORD ?? "",
    totpSecret: process.env.QA_TOTP_SECRET ?? "",
  };
  const secrets = () =>
    [...secretsToRedact(), credentials.password, credentials.totpSecret]
      .filter((v) => typeof v === "string" && v.trim().length >= 6)
      .sort((a, b) => b.length - a.length);

  const finish = async (journeys: Parameters<typeof buildSummary>[0]["journeys"], probe: ProbeInfo | null, globalErrors: string[]) => {
    const summary = buildSummary({ runId, baseURL: origin, startedAt, journeys, probe, globalErrors, notes: notes.map((n) => redact(n, secrets())) });
    writeSummary(ROOT, summary);
    const c = summary.counts;
    log("");
    log(` AI PROBE RESULT: ${summary.verdict}   ${c.passed} passed · ${c.failed} failed · ${c.flaky} flaky · ${c.skipped} skipped · ${Math.round(summary.durationMs / 1000)}s`);
    for (const e of summary.globalErrors) log(` ! ${e}`);
    summary.problems.forEach((p, i) => log(` ${i + 1}. ${p.headline}${p.failedStep ? ` (step: ${p.failedStep})` : ""}`));
    if (probe) {
      log(
        probe.mode === "recorded"
          ? " Cost: recorded plan, no model calls, $0."
          : ` Cost: ${probe.tokens.input} input + ${probe.tokens.output} output tokens with ${probe.model}, about $${probe.approxCostUsd.toFixed(4)} at list prices.`,
      );
    }
    log(` Report: qa-results/${runId}/report.md`);
    const first = summary.problems[0]?.headline;
    await say(
      summary.verdict === "PASS" ? `Verdict PASS: ${c.passed} passed, ${c.flaky} flaky, ${c.skipped} skipped.`
        : summary.verdict === "FAIL" ? `Verdict FAIL: ${c.failed} failed. First problem: ${first}.`
          : `Verdict ${summary.verdict}: ${summary.globalErrors[0] ?? "nothing could run"}.`,
      "verdict",
    );
    return summary.verdict === "PASS" ? 0 : summary.verdict === "FAIL" ? 1 : 2;
  };

  const recorded = readPlan(args.plan as string | undefined ?? process.env.PROBE_PLAN_IN, origin);
  if (!recorded && !hasAnthropicKey()) {
    log(`• ${NO_KEY_NO_PLAN}`);
    await say(NO_KEY_NO_PLAN, "error");
    return finish([], null, [NO_KEY_NO_PLAN]);
  }
  const mode: ProbeInfo["mode"] = recorded ? "recorded" : "planned";
  const intro = recorded
    ? `Using recorded plan (${recorded.journeys.length} journeys)`
    : `Planning with Claude Haiku (${PROBE_MODEL})`;
  log(`• ${intro}. ${readOnly ? "Read-only on this host: anything that would change data is skipped." : "Writes are allowed on this host."}`);
  await say(`${intro}. ${readOnly ? "Read-only on this host." : "Writes allowed on this host."}`, "start");

  let session;
  try {
    session = await openProbeSession({ origin, start, credentials, readOnly, headed: !!args.headed, log, notes });
  } catch (error) {
    return finish([], null, [`${origin}${start} did not load: ${redact((error as Error).message.split("\n")[0], secrets())}`]);
  }

  try {
    let journeys: ProbeJourney[];
    let tokens = { input: 0, output: 0 };
    if (recorded) {
      journeys = recorded.journeys;
    } else {
      log("• Looking at a few pages before planning…");
      const screens = await lookAround(session, origin);
      try {
        const planned = await planJourneys({ origin, screens, secrets: secrets(), maxSteps, maxTokens });
        journeys = planned.journeys;
        tokens = planned.tokens;
        log(`• ${PROBE_MODEL} proposed ${journeys.length} journeys${planned.cached ? " (from the cache, no charge)" : ""}.`);
      } catch (error) {
        if (error instanceof PlanError) return await finish([], null, [error.message]);
        throw error;
      }
    }

    const { results, recorded: executed } = await runJourneys(
      { session, origin, readOnly, calibrate: !recorded, workDir, secrets, log, notes },
      journeys,
    );

    const probe: ProbeInfo = {
      mode,
      model: recorded ? recorded.model : PROBE_MODEL,
      journeys: results.length,
      steps: results.reduce((n, j) => n + j.steps.length, 0),
      tokens,
      approxCostUsd: approxCost(tokens),
      readOnly,
    };

    // Record what actually ran, so the next Probe replays it without a model. Values are fake test data, redacted anyway.
    const out = process.env.PROBE_PLAN_OUT;
    if (!recorded && out && executed.length) {
      const plan: ProbePlan = { version: 1, origin, model: PROBE_MODEL, createdAt: new Date().toISOString(), journeys: JSON.parse(redact(JSON.stringify(executed), secrets())) };
      writeFileSync(out, JSON.stringify(plan, null, 2));
      log(`• Recorded ${executed.length} journeys. The next Probe replays them with no model calls.`);
    }
    return await finish(results, probe, []);
  } finally {
    await session.close();
  }
}

async function main(): Promise<number> {
  const target = (args.target ?? args["base-url"]) as string | undefined;
  if (!target || (await isStandIn(target))) {
    log("• Probe: built-in suite (the target is the Eclypse stand-in).");
    if (linked()) await say("This target is our stand-in, so the built-in suite runs.", "start");
    return runBuiltInSuite();
  }
  log(`• Probe: AI Probe (${new URL(target).host} is not the stand-in).`);
  await say(`Running the AI Probe on ${new URL(target).host}.`, "start");
  return aiProbe(target);
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`AI Probe error: ${redact((error as Error).message, secretsToRedact())}`);
    process.exit(3);
  },
);
