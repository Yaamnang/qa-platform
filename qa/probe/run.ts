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
 *     Otherwise the Probe signs in, explores every page it can reach
 *     (pages.ts) and Claude Haiku plans journeys for them in batches (plan.ts).
 *     Limits are in limits.ts.
 *     Neither a key nor a plan: stop with a clear message.
 *  2. execute.ts runs every step with Playwright and checks its outcome. The
 *     verdict comes only from those checks.
 *  3. After a planning run, the journeys as executed are written to
 *     PROBE_PLAN_OUT, which the console saves on the workspace.
 *
 * Read-only unless PROBE_WRITES_ALLOWED=1 (the console sets it on this
 * machine, or when the workspace's Full access is on). Exit code: 0 PASS, 1 FAIL, 2 could not run, 3 runner error.
 * The last lines print "Report: qa-results/<run id>/report.md", which is how
 * the console finds summary.json.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { Credentials } from "../explore/crawl";
import { redact, secretsToRedact } from "../explore/redact";
import { linked, say } from "../lib/console-link";
import { hasAnthropicKey, isStandIn, NO_KEY_NO_PLAN } from "./detect";
import { runJourneys } from "./execute";
import { MAX_JOURNEYS, MAX_MINUTES, MAX_STEPS_TOTAL, MAX_TOKENS } from "./limits";
import { explorePages } from "./pages";
import { approxCost, planFirstPages, planSite, PROBE_MODEL, samePath } from "./plan";
import { imageTag } from "../reporter/plain-report";
import { buildSummary, writeSummary } from "./report";
import { openProbeSession } from "./session";
import type { ExploredPage, ProbeInfo, ProbeJourney, ProbePlan } from "./types";

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

async function aiProbe(target: string): Promise<number> {
  const startedAt = new Date();
  const runId = `${startedAt.toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}-${randomBytes(2).toString("hex")}`;
  const origin = new URL(target).origin;
  const start = samePath(new URL(target).pathname || "/", origin) ?? "/";
  const readOnly = process.env.PROBE_WRITES_ALLOWED !== "1";
  // The console still passes PROBE_MAX_STEPS and PROBE_MAX_TOKENS through (lib/console/server/probe.ts); the limits live in limits.ts.
  const maxSteps = Number(process.env.PROBE_MAX_STEPS) || MAX_STEPS_TOTAL;
  const maxTokens = Number(process.env.PROBE_MAX_TOKENS) || MAX_TOKENS;
  const deadline = startedAt.getTime() + MAX_MINUTES * 60_000;
  const workDir = process.env.PROBE_DIR || path.join(ROOT, "qa-results", runId);
  mkdirSync(workDir, { recursive: true });
  const notes: string[] = [];
  const credentials: Credentials = {
    email: process.env.QA_EMAIL ?? "",
    password: process.env.QA_PASSWORD ?? "",
    totpSecret: process.env.QA_TOTP_SECRET ?? "",
  };
  const secrets = () => secretsToRedact([credentials.password, credentials.totpSecret]);

  const finish = async (journeys: Parameters<typeof buildSummary>[0]["journeys"], probe: ProbeInfo | null, globalErrors: string[]) => {
    const summary = buildSummary({ runId, baseURL: origin, startedAt, journeys, probe, globalErrors, notes: notes.map((n) => redact(n, secrets())) });
    writeSummary(ROOT, summary);
    const c = summary.counts;
    log("");
    log(` AI PROBE RESULT: ${summary.verdict}   ${c.passed} passed · ${c.failed} failed · ${c.flaky} flaky · ${c.skipped} skipped · ${Math.round(summary.durationMs / 1000)}s`);
    for (const e of summary.globalErrors) log(` ! ${e}`);
    if (summary.notRun) log(` ${summary.notRun}`);
    summary.problems.forEach((p, i) => log(` ${i + 1}. ${p.headline}${p.failedStep ? ` (step: ${p.failedStep})` : ""}${imageTag(p)}`));
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
      summary.verdict === "PASS" ? `Verdict PASS: ${c.passed} passed, ${c.flaky} flaky, ${c.skipped} skipped.${summary.notRun ? ` ${summary.notRun}` : ""}`
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
    : `Exploring every page I can reach, then planning with Claude Haiku (${PROBE_MODEL})`;
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
    let calls = 0;
    let cachedCalls = 0;
    let pages: ExploredPage[] | undefined = recorded?.pages;
    const limits: string[] = [];
    if (recorded) {
      journeys = recorded.journeys;
    } else {
      log("• Exploring every page I can reach…");
      const site = await explorePages({ session, origin, start, log, notes });
      log(`• Explored ${site.pages.length} page patterns (${site.opened} pages opened). Stopped because ${site.stoppedBecause}.`);
      if (site.notVisited.length) limits.push(`Stopped exploring: ${site.stoppedBecause}. Not visited: ${site.notVisited.slice(0, 10).join(", ")}${site.notVisited.length > 10 ? ` and ${site.notVisited.length - 10} more` : ""}`);
      let plan: Awaited<ReturnType<typeof planSite>> | null = null;
      try {
        plan = await planSite({ origin, pages: site.pages, secrets: secrets(), readOnly, maxJourneys: MAX_JOURNEYS, maxSteps, maxTokens, log });
      } catch (error) {
        log(`• Batch planning failed: ${redact((error as Error).message.split("\n")[0], secrets())}`);
      }
      journeys = plan?.journeys ?? [];
      if (plan) {
        tokens = plan.tokens;
        calls = plan.calls;
        cachedCalls = plan.cachedCalls;
        pages = plan.pages;
        limits.push(...plan.limits);
      }
      if (!journeys.length && site.pages.length && !plan?.fatal) {
        // Safety net: the way the Probe planned before, one call over the first pages.
        await say("Planning page by page gave nothing to run, so I am planning once over the first pages instead.", "step");
        try {
          const fallback = await planFirstPages({ origin, pages: site.pages, secrets: secrets(), readOnly });
          journeys = fallback.journeys;
          tokens = { input: tokens.input + fallback.tokens.input, output: tokens.output + fallback.tokens.output };
          calls++;
        } catch (error) {
          log(`• The single planning call failed too: ${redact((error as Error).message.split("\n")[0], secrets())}`);
        }
      }
      if (!journeys.length) {
        const why = plan?.fatal ?? (site.pages.length ? "No journeys could be planned for this site." : "No page could be explored on this site.");
        for (const line of limits) log(`• ${line}`);
        return await finish([], null, [why]);
      }
      const line = `Explored ${site.pages.length} pages. Planned ${journeys.length} journeys.`;
      log(`• ${line}${cachedCalls ? ` ${cachedCalls} batch(es) came from the cache, no charge.` : ""}`);
      await say(line, "step");
      for (const limit of limits) {
        log(`• ${limit}`);
        await say(limit, "step");
      }
    }

    const { results, recorded: executed, notRun } = await runJourneys(
      { session, origin, readOnly, calibrate: !recorded, deadline, workDir, imagesDir: path.join(ROOT, "qa-results", runId, "images"), secrets, log, notes },
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
      calls,
      cachedCalls,
      pages: pages && coverage(pages, executed),
      limits,
    };
    if (notRun.length) {
      const line = `Stopped at the time limit of ${MAX_MINUTES} minutes. Not run: ${notRun.join(", ")}`;
      limits.push(line);
      await say(line, "step");
    }

    // Record what actually ran, so the next Probe replays it without a model. Values are fake test data, redacted anyway.
    const out = process.env.PROBE_PLAN_OUT;
    if (!recorded && out && executed.length) {
      const plan: ProbePlan = {
        version: 1, origin, model: PROBE_MODEL, createdAt: new Date().toISOString(),
        journeys: JSON.parse(redact(JSON.stringify(executed), secrets())),
        ...(probe.pages ? { pages: probe.pages } : {}),
      };
      writeFileSync(out, JSON.stringify(plan, null, 2));
      log(`• Recorded ${executed.length} journeys. The next Probe replays them with no model calls.`);
    }
    return await finish(results, probe, []);
  } finally {
    await session.close();
  }
}

/** The pages with the journeys that actually ran on them. A planning run drops journeys whose elements were not there. */
function coverage(pages: ExploredPage[], ran: ProbeJourney[]): ExploredPage[] {
  return pages.map((p) => {
    const names = ran.filter((j) => j.page === p.page).map((j) => j.name);
    if (names.length) return { page: p.page, example: p.example, journeys: names };
    return { page: p.page, example: p.example, journeys: [], note: p.journeys.length ? "planned journeys did not fit the page and were dropped" : p.note ?? "no journey" };
  });
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
