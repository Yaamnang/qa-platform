import "server-only";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { redact } from "@/qa/explore/redact";
import type { ExplorerSummary, Proposal as ExplorerProposal } from "@/qa/explore/types";
import type { Summary } from "@/qa/reporter/plain-report";
import type { Job, JobKind, JobOrigin, Proposal } from "../contract";
import { closeLink, openLink, waitedMs } from "./chat";
import { moveImagesToStore } from "./job-images";
import { dropFrame } from "./live-frames";
import { summarize } from "./summary";
import { decryptSecret } from "./encryption";
import { probeChildEnv, probeExtras, saveRecordedPlan } from "./probe";
import { hostOf } from "./projects";
import { MANUAL_ORIGIN, type JobPatch, type JobRecord, type ProjectRecord } from "./records";
import { createJob, listUnfinishedJobs, updateJob } from "./store";

/**
 * The job runner. Starts an explore or qa job as a child process, follows its
 * output, and records what it found.
 *
 * One job at a time across the whole console: there is one browser and one
 * set of ports on this machine, and two runs signing in as the same QA account
 * would also fight over its one-time codes.
 *
 * How the child is started, and why that leaves no room for shell injection:
 *  - The program is process.execPath, the Node binary running this server,
 *    and its first argument is the tsx CLI file inside node_modules. No npx
 *    and no PATH lookup, so nothing outside the repo decides what runs.
 *  - There is no shell. spawn() gets an argument array, and the target URL is
 *    one element of it, checked as http(s) when the project was added. A
 *    quote, semicolon or backtick in it reaches the child as plain text.
 *  - Neither of those depends on the operating system, so the same code runs
 *    on Windows and Linux.
 *  - The decrypted QA credentials go only into the child's environment: never
 *    into an argument (anyone listing processes can read those), a file or a log.
 *  - The child also gets CONSOLE_JOB_URL and CONSOLE_JOB_TOKEN, a random token
 *    for this job only, so it can talk to the job's chat (chat.ts). A workspace
 *    without saved credentials still runs: the child asks for them there.
 *
 * Restarts: on the in-memory backend a server restart loses running jobs,
 * along with everything else in memory, which is acceptable for the demo
 * store. On Supabase the job rows survive but their runner does not, so the
 * first console request after a restart marks them as errors
 * (recoverInterruptedJobs below).
 */

const ROOT = process.cwd();
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SCRIPT: Record<JobKind, string> = {
  explore: path.join("qa", "explore", "run.ts"),
  // Picks the built-in suite (qa/run.ts) for the stand-in and the AI Probe for any other site.
  qa: path.join("qa", "probe", "run.ts"),
};

/**
 * Hard limit per job. The child is killed when it is reached. Time spent in
 * status "waiting" (the run asked the employee something) does not count.
 */
const TIMEOUT: Record<JobKind, { variable: string; defaultMs: number }> = {
  explore: { variable: "CONSOLE_EXPLORE_TIMEOUT_MS", defaultMs: 5 * 60_000 },
  qa: { variable: "CONSOLE_QA_TIMEOUT_MS", defaultMs: 10 * 60_000 },
};

const LOG_LINES = 200;
/** How often the log tail is written while a job runs, so the page can show progress without a write per line. */
const FLUSH_EVERY_MS = 1000;
/** After asking the child to stop, how long before it is forced to. */
const KILL_GRACE_MS = 5000;

export const BUSY_MESSAGE =
  "Another job is already running. The console runs one job at a time because there is one browser and one set of ports. Start this one when it has finished.";

/**
 * Environment variable names whose values count as secret. Such variables are
 * not passed on to the child, and their values are redacted from its output.
 */
const SECRET_NAME = /KEY|SECRET|PASSWORD|TOKEN/i;

/**
 * Also not passed on: the console's own settings, the stand-in's seeded
 * accounts, Supabase, and any QA_* setting of this server. The child gets
 * exactly the QA_* values this job sets, so a local QA bot or allow-list can
 * never leak into a run against another target.
 */
const NOT_INHERITED = /^(CONSOLE_|SEED_|SUPABASE_|QA_)/;

/**
 * The explore child, and only that child, gets these back after the strip
 * above. With the key it can let Claude drive the read-only browser
 * (qa/explore/agent.ts); without it, it uses its built-in rules. EXPLORE_MAX_TOKENS
 * is a number, not a secret, but its name contains TOKEN, so it would be
 * stripped too. The Probe child gets the key only to plan the AI Probe
 * (probe.ts probeChildEnv); it is stripped again before the built-in suite
 * starts, and no model has a say in whether a run passes.
 */
const EXPLORE_PASSTHROUGH = ["ANTHROPIC_API_KEY", "EXPLORE_MODEL", "EXPLORE_MAX_STEPS", "EXPLORE_MAX_TOKENS"] as const;

/** Names that match SECRET_NAME but hold no secret. Redacting "200000" from every log line helps nobody. */
const NOT_SECRET = new Set<string>(["EXPLORE_MAX_TOKENS"]);

/** Colour codes, in case a child prints them. They mean nothing on the page. */
const ANSI = /\u001b\[[0-9;]*m/g;

/** A job's own folder: the explorer's map and draft, and the proposals JSON. Under qa-results/, which git ignores. */
export function jobDir(jobId: string): string {
  return path.join(ROOT, "qa-results", "console", jobId);
}

// ---------------------------------------------------------------------------
// The one slot
// ---------------------------------------------------------------------------

/** stoppedBy: the employee who pressed Stop, once they have. */
type Slot = { child: ChildProcess | null; jobId: string | null; stoppedBy: string | null };

type RunnerState = {
  /** The job holding the slot, or null when idle. child is null while the job is still being created. */
  active: Slot | null;
  /** The restart clean-up, run once per process. */
  recovery: Promise<void> | null;
  exitHookInstalled: boolean;
};

/** On globalThis, like the in-memory store, so a hot reload in development keeps the slot and its child. */
const globalForRunner = globalThis as unknown as { __eclypseConsoleRunner?: RunnerState };
const state: RunnerState = (globalForRunner.__eclypseConsoleRunner ??= {
  active: null,
  recovery: null,
  exitHookInstalled: false,
});

// ---------------------------------------------------------------------------
// After a restart
// ---------------------------------------------------------------------------

/**
 * Marks jobs left queued or running by a console server process that no
 * longer exists. Nothing will ever finish them, and left alone they would hold
 * the one-job slot for good.
 *
 * Runs once per process, before the first job is shown or started. If it fails
 * (database unreachable) the next request tries again.
 */
export function recoverInterruptedJobs(): Promise<void> {
  state.recovery ??= markInterruptedJobs().catch((err: unknown) => {
    state.recovery = null;
    throw err;
  });
  return state.recovery;
}

async function markInterruptedJobs(): Promise<void> {
  for (const job of await listUnfinishedJobs()) {
    if (!runnerIsGone(job)) continue;
    await updateJob(job.id, {
      status: "error",
      finishedAt: Date.now(),
      error: "The console server stopped while this job was running, so its result was lost. Start the job again.",
    });
  }
}

function runnerIsGone(job: JobRecord): boolean {
  // Processes on another machine cannot be seen from here. That server
  // tidies up its own jobs when it restarts.
  if (job.runnerHost !== os.hostname()) return false;
  // This process has not started a job yet (startJob waits for the clean-up),
  // so a job recorded under its own pid belongs to an earlier process that
  // got the same pid, which is common in containers.
  if (job.runnerPid === process.pid) return true;
  return !processExists(job.runnerPid);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 sends nothing, it only asks whether the process exists. Works on Windows too.
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists, but belongs to another user
  }
}

// ---------------------------------------------------------------------------
// Starting a job
// ---------------------------------------------------------------------------

export type StartResult = { job: JobRecord } | { busy: string };

type Credentials = { email: string; password: string; totpSecret: string };

/**
 * Creates the job and starts its child process. Resolves as soon as the child
 * is running; the route answers 202 and the page polls the job.
 *
 * The caller has already decided whether a qa job may change data (writesAllowed),
 * checked that the Probe can start with that, and for a GitHub-started job that
 * credentials are saved. Use startProjectJob in start.ts, which does those
 * checks, rather than calling this directly.
 *
 * origin says who asked: the console's pages (manual) or GitHub with
 * the commit that caused the run. It is only stored, it changes nothing here.
 * writesAllowed becomes PROBE_WRITES_ALLOWED for a qa job. Explore ignores it.
 * attended becomes CONSOLE_ATTENDED: is a person watching who can be asked?
 */
export async function startJob(
  project: ProjectRecord,
  kind: JobKind,
  createdBy: string,
  origin: JobOrigin = MANUAL_ORIGIN,
  callbackBase: string = defaultCallbackBase(),
  writesAllowed = false,
  attended = false,
): Promise<StartResult> {
  await recoverInterruptedJobs();

  // The slot is taken before the next await. Node runs this part without
  // interruption, so of two requests arriving together exactly one gets past.
  if (state.active) return { busy: BUSY_MESSAGE };
  const slot: Slot = { child: null, jobId: null, stoppedBy: null };
  state.active = slot;

  let job: JobRecord | null = null;
  try {
    // The database can know of a job this process does not: one run by
    // another console server on the same database.
    if ((await listUnfinishedJobs()).length > 0) {
      state.active = null;
      return { busy: BUSY_MESSAGE };
    }
    const credentials = decryptCredentials(project);
    job = await createJob({
      projectId: project.id,
      kind,
      createdBy,
      runnerHost: os.hostname(),
      runnerPid: process.pid,
      origin,
    });
    slot.jobId = job.id;
    return { job: await launch(job, project, credentials, slot, callbackBase, writesAllowed, attended) };
  } catch (err) {
    state.active = null;
    // launch only throws before the child exists. A job row left queued
    // would hold the slot for good, so it is closed off.
    if (job) {
      await updateJob(job.id, { status: "error", finishedAt: Date.now(), error: "The job could not be started." }).catch(
        () => undefined,
      );
    }
    throw err;
  }
}

/** Whatever the workspace has saved. A missing part is an empty string: the run asks for it in the chat. */
function decryptCredentials(project: ProjectRecord): Credentials {
  return {
    email: project.qaEmail,
    password: project.qaPasswordEnc ? decryptSecret(project.qaPasswordEnc) : "",
    totpSecret: project.qaTotpSecretEnc ? decryptSecret(project.qaTotpSecretEnc) : "",
  };
}

/**
 * Where the child reaches this server. Always loopback: the token must never
 * be sent to an address taken from a request header. CONSOLE_INTERNAL_URL
 * overrides it for unusual setups.
 */
export function defaultCallbackBase(port?: string): string {
  const configured = process.env.CONSOLE_INTERNAL_URL?.trim().replace(/\/+$/, "");
  return configured || `http://localhost:${port || process.env.PORT || 3000}`;
}

type Link = { url: string; token: string };

/** Everything the child inherits, minus secrets and settings that are not its business, plus this job's account. */
function childEnv(kind: JobKind, credentials: Credentials, host: string, link: Link, attended: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (SECRET_NAME.test(name) || NOT_INHERITED.test(name)) delete env[name];
  }
  if (kind === "explore") {
    for (const name of EXPLORE_PASSTHROUGH) {
      const value = process.env[name];
      if (value) env[name] = value;
    }
  }
  return {
    ...env,
    QA_EMAIL: credentials.email,
    QA_PASSWORD: credentials.password,
    QA_TOTP_SECRET: credentials.totpSecret,
    // Both commands refuse any other host. For a qa job this is the runner's
    // own preflight; explore checks it too when it is set.
    QA_ALLOWED_HOSTS: host,
    // The job's chat. See qa/lib/console-link.ts.
    CONSOLE_JOB_URL: link.url,
    CONSOLE_JOB_TOKEN: link.token,
    // 1 when an employee started the run and is watching it. See attended() in qa/lib/console-link.ts.
    CONSOLE_ATTENDED: attended ? "1" : "0",
    ...(process.env.CONSOLE_ASK_TIMEOUT_MS ? { CONSOLE_ASK_TIMEOUT_MS: process.env.CONSOLE_ASK_TIMEOUT_MS } : {}),
  };
}

/**
 * Values that must never reach the log tail: this job's password and TOTP
 * secret whatever their length, and the value of every variable of this
 * server whose name looks secret. Those need six characters or more, as in
 * qa/explore/redact.ts, so a flag like SOME_TOKEN_TTL=60 does not turn every
 * "60" in the log into [redacted]. Longest first, so overlaps go whole.
 */
function secretsToHide(credentials: Credentials): string[] {
  const fromEnv = Object.entries(process.env)
    .filter(([name, value]) => SECRET_NAME.test(name) && !NOT_SECRET.has(name) && typeof value === "string" && value.trim().length >= 6)
    .map(([, value]) => value as string);
  return [credentials.password, credentials.totpSecret, ...fromEnv]
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length);
}

async function launch(
  job: JobRecord,
  project: ProjectRecord,
  credentials: Credentials,
  slot: Slot,
  callbackBase: string,
  writesAllowed: boolean,
  attended: boolean,
): Promise<JobRecord> {
  const kind = job.kind;
  const dir = jobDir(job.id);
  const proposalsFile = path.join(dir, "proposals.json");

  const args = [TSX_CLI, SCRIPT[kind], "--target", project.targetUrl];
  if (kind === "explore") {
    // auto: Claude drives the read-only browser when this server has an
    // ANTHROPIC_API_KEY (passed to this child only, see childEnv), and the
    // built-in rules run otherwise. Spend is capped by EXPLORE_MAX_STEPS and
    // EXPLORE_MAX_TOKENS. --out keeps its map and draft in this job's folder.
    mkdirSync(dir, { recursive: true });
    args.push("--ai-mode", "auto", "--out", dir, "--json-out", proposalsFile);
  }

  // Every line is cleaned and redacted before it is kept, so nothing secret
  // is ever stored, not even for a second. The list is shared with the job's
  // chat, which adds the callback token now and any login or code the
  // employee gives later.
  const secrets = secretsToHide(credentials);
  const lines: string[] = [];
  let logChanged = false;
  let qaRunId: string | null = null;
  const addLine = (raw: string) => {
    const line = redact(raw.replace(ANSI, "").replace(/\r/g, ""), secrets);
    // The QA runner prints "Report: qa-results/<run id>/report.md"; summary.json sits next to it.
    qaRunId = line.match(/Report: qa-results\/([\w-]+)\/report\.md/)?.[1] ?? qaRunId;
    // Each line gets the time it arrived (UTC, like the chat), so the log reads as a timeline.
    lines.push(line.trim() ? `${new Date().toISOString().slice(11, 19)} ${line}` : line);
    if (lines.length > LOG_LINES) lines.splice(0, lines.length - LOG_LINES);
    logChanged = true;
  };
  const clean = (text: string) => redact(text, secrets);
  // Without its time, since it is quoted inside an error message.
  const lastLine = () => ([...lines].reverse().find((line) => line.trim()) ?? "").replace(LOG_TIME, "");

  // Writes for this job go out one after another, in order, so a late log
  // flush can never land on top of the final result. A failed write is
  // logged, never thrown: the child is running and still has to be followed.
  let writes: Promise<void> = Promise.resolve();
  const write = (patch: JobPatch) => {
    writes = writes
      .then(() => updateJob(job.id, patch))
      .catch((err: unknown) => {
        console.error(`[console] Could not update job ${job.id}:`, err instanceof Error ? err.message : err);
      });
    return writes;
  };

  const token = openLink(job.id, write, secrets);
  const link: Link = { url: `${callbackBase}/api/console/jobs/${job.id}/agent`, token };

  // Probe only: the recorded plan, where to record a new one, whether writes are allowed, the model key (lib/console/server/probe.ts).
  const probeEnv = kind === "qa" ? await probeChildEnv(project, dir, writesAllowed) : {};
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...childEnv(kind, credentials, hostOf(project.targetUrl), link, attended), ...probeEnv },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false, // the default, written out so nobody "simplifies" it into a shell string later
    windowsHide: true,
    // Outside Windows the child leads its own process group, so stopping it
    // can stop everything it started as well. See stopTree.
    detached: process.platform !== "win32",
  });
  slot.child = child;
  installExitHook();

  const stdout = lineSplitter(addLine);
  const stderr = lineSplitter(addLine);
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (text: string) => stdout.write(text));
  child.stderr?.on("data", (text: string) => stderr.write(text));

  const flusher = setInterval(() => {
    if (!logChanged) return;
    logChanged = false;
    void write({ logTail: lines.join("\n") });
  }, FLUSH_EVERY_MS);

  const startedAt = Date.now();
  const limit = TIMEOUT[kind];
  const limitMs = positiveNumber(process.env[limit.variable]) ?? limit.defaultMs;
  let timedOut = false;
  // Checked every second instead of one fixed timer, because time spent
  // waiting for the employee's answer is taken off.
  const killer = setInterval(() => {
    if (timedOut || Date.now() - startedAt - waitedMs(job.id) < limitMs) return;
    timedOut = true;
    addLine(`[console] Time limit of ${duration(limitMs)} reached. Stopping the job.`);
    stopTree(child);
  }, 1000);
  let spawnError: Error | null = null;
  let finished = false;

  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (finished) return;
    finished = true;
    clearInterval(killer);
    clearInterval(flusher);
    stdout.end();
    stderr.end();

    let outcome: JobPatch;
    try {
      if (spawnError) {
        outcome = failure(`The ${kind} command could not be started: ${clean(spawnError.message)}`);
      } else if (slot.stoppedBy) {
        outcome = failure(`Stopped by ${slot.stoppedBy} after ${duration(Date.now() - startedAt)}.`);
      } else if (timedOut) {
        outcome = failure(
          `Stopped after ${duration(limitMs)}, the time limit for ${kind} jobs. Set ${limit.variable} to allow longer.`,
        );
      } else if (kind === "explore") {
        outcome = exploreOutcome(code, signal, proposalsFile, clean, lastLine());
      } else {
        outcome = qaOutcome(code, signal, qaRunId, startedAt, clean, lastLine());
      }
    } catch {
      // Output in a shape nobody expected. This runs in an event handler, where
      // an exception would take the whole server down, so it becomes the job's error.
      outcome = failure(`The ${kind} job finished, but its output could not be read.`);
    }

    // Closing the chat first means nothing it does later can reach the store.
    const messages = closeLink(job.id);
    // The live view's last frame goes with it: frames live only while the job runs.
    dropFrame(job.id);
    // The explorer summary and the chat go in writes of their own, after the
    // result. On a Supabase database that has not had the newer columns added
    // (db/schema-console.sql), only those writes fail, and the result is kept.
    const { explorer, ...result } = outcome;
    // Probe only: the problem images go into the store and their files off the
    // disk first, so a note about it is in the log the final write stores. Never throws.
    const images = kind === "qa" ? moveImagesToStore(job.id, outcome.result, addLine) : Promise.resolve();
    void images.then(() => {
      void write({ ...result, logTail: lines.join("\n"), finishedAt: Date.now() }).then(() => {
        // Free the slot only once the final state is stored, so the next job
        // never sees this one as still running.
        if (state.active === slot) state.active = null;
      });
      if (explorer !== undefined) void write({ explorer });
      if (kind === "qa") void saveRecordedPlan(project.id, dir);
      if (messages) void write({ messages });
      // Last, in a write of its own: it can take up to 10 s, and it is advisory only.
      void summarize(
        {
          kind,
          status: outcome.status ?? "error",
          result: outcome.result,
          proposals: outcome.proposals,
          explorer,
          error: outcome.error,
          durationMs: Date.now() - startedAt,
          logLines: [...lines],
          messages: messages ?? [],
        },
        clean,
      )
        .then((summary) => write({ summary }))
        .catch(() => undefined);
    });
  };

  child.on("error", (err) => {
    spawnError = err;
    finish(null, null);
  });
  // 'close' comes after the process has exited and all its output has been read.
  child.on("close", (code, signal) => finish(code, signal));
  child.on("exit", () => {
    // Anything the child left behind in its group, such as a stray browser,
    // would keep the output pipes open and hold back 'close'.
    if (process.platform !== "win32" && child.pid !== undefined) signalGroup(child.pid, "SIGKILL");
    // And if something outside the group still holds them, do not wait forever.
    setTimeout(() => finish(child.exitCode, child.signalCode), KILL_GRACE_MS).unref();
  });

  await write({ status: "running", startedAt });
  return { ...job, status: "running", startedAt };
}

// ---------------------------------------------------------------------------
// Reading what the child produced
// ---------------------------------------------------------------------------

function failure(reason: string): JobPatch {
  return { status: "error", error: reason };
}

/** The "HH:MM:SS " a log line starts with (addLine in runJob). */
const LOG_TIME = /^\d{2}:\d{2}:\d{2} /;

function lastOutput(line: string): string {
  return line ? ` Last output: ${line}` : " It printed nothing.";
}

/** Exit codes from qa/explore/run.ts: 0 done, 2 environment unavailable or sign-in refused, 3 command error. */
function exploreOutcome(
  code: number | null,
  signal: NodeJS.Signals | null,
  proposalsFile: string,
  clean: (text: string) => string,
  last: string,
): JobPatch {
  if (signal) return failure(`The explorer was stopped (${signal}) before it finished.${lastOutput(last)}`);
  if (code === 2) {
    return failure(`The explorer could not use the target: it did not answer, or it refused the QA account.${lastOutput(last)}`);
  }
  if (code !== 0) return failure(`The explorer stopped with an error (exit code ${code}).${lastOutput(last)}`);
  const output = readExplorerOutput(proposalsFile, clean);
  if (!output) return failure("The explorer finished, but its proposals file was missing or could not be read.");
  return { status: "passed", proposals: output.proposals, explorer: output.explorer, error: null };
}

const SEVERITIES = new Set(["critical", "high", "medium", "low"]);

function isExplorerProposal(value: unknown): value is ExplorerProposal {
  const p = value as ExplorerProposal;
  const strings = (list: unknown) => Array.isArray(list) && list.every((item) => typeof item === "string");
  return (
    typeof p === "object" &&
    p !== null &&
    typeof p.journey === "string" &&
    typeof p.area === "string" &&
    SEVERITIES.has(p.severity) &&
    strings(p.steps) &&
    strings(p.expectations)
  );
}

const EXPLORER_MODES = new Set(["rules", "claude", "replay"]);
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** The explorer's own summary of how it ran. Anything malformed is dropped: it only feeds one line on the page. */
function readExplorerSummary(value: unknown, clean: (text: string) => string): ExplorerSummary | null {
  const e = value as ExplorerSummary;
  if (typeof e !== "object" || e === null || !EXPLORER_MODES.has(e.mode) || typeof e.model !== "string") return null;
  if (!count(e.steps) || !count(e.approxCostUsd) || typeof e.tokens !== "object" || !count(e.tokens?.input) || !count(e.tokens?.output)) {
    return null;
  }
  return {
    mode: e.mode,
    model: clean(e.model),
    steps: e.steps,
    tokens: { input: e.tokens.input, output: e.tokens.output },
    approxCostUsd: e.approxCostUsd,
  };
}

/**
 * The --json-out file: { explorer, proposals }, or a bare proposals array
 * from an older explorer. Each proposal gets an id, p1, p2 and so on in the
 * order the explorer listed them, so an id names the same proposal for the
 * life of the job. Text is redacted again here: the explorer already does it,
 * and a second pass costs nothing.
 */
function readExplorerOutput(
  file: string,
  clean: (text: string) => string,
): { proposals: Proposal[]; explorer: ExplorerSummary | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const wrapped = !Array.isArray(parsed) && typeof parsed === "object" && parsed !== null;
  const list: unknown = wrapped ? (parsed as { proposals?: unknown }).proposals : parsed;
  if (!Array.isArray(list) || !list.every(isExplorerProposal)) return null;
  const explorer = wrapped ? readExplorerSummary((parsed as { explorer?: unknown }).explorer, clean) : null;
  return { proposals: toProposals(list, clean), explorer };
}

function toProposals(list: ExplorerProposal[], clean: (text: string) => string): Proposal[] {
  return list.map((p, index) => ({
    id: `p${index + 1}`,
    journey: clean(p.journey),
    area: clean(p.area),
    severity: p.severity,
    steps: p.steps.map(clean),
    expectations: p.expectations.map(clean),
  }));
}

/** Exit codes from qa/run.ts: 0 PASS, 1 FAIL, 2 environment unavailable or safety stop, 3 runner error. */
function qaOutcome(
  code: number | null,
  signal: NodeJS.Signals | null,
  runId: string | null,
  startedAt: number,
  clean: (text: string) => string,
  last: string,
): JobPatch {
  const summary = readSummary(runId, startedAt);
  if (!summary) {
    if (signal) return failure(`The QA run was stopped (${signal}) before it produced a result.${lastOutput(last)}`);
    return failure(`The QA run ended (exit code ${code}) without a readable summary.json.${lastOutput(last)}`);
  }
  const result = toResult(summary, clean);
  if (summary.verdict === "PASS") return { status: "passed", result, error: null };
  if (summary.verdict === "FAIL") return { status: "failed", result, error: null };
  // ENVIRONMENT UNAVAILABLE or SAFETY STOP: the suite never got as far as
  // judging the product. The runner's own message usually starts with the verdict already.
  const reason = (summary.globalErrors ?? [])[0] ?? "No tests were run.";
  return { status: "error", result, error: clean(reason.startsWith(summary.verdict) ? reason : `${summary.verdict}: ${reason}`) };
}

/**
 * The run's own summary.json, found from the run id the runner printed, or
 * qa-results/latest/summary.json if the id was not seen. latest/ could still
 * hold an older run if this one never got that far, so a summary only counts
 * if its run started after this job did.
 */
function readSummary(runId: string | null, jobStartedAt: number): Summary | null {
  const candidates = [
    ...(runId ? [path.join(ROOT, "qa-results", runId, "summary.json")] : []),
    path.join(ROOT, "qa-results", "latest", "summary.json"),
  ];
  for (const file of candidates) {
    try {
      const summary = JSON.parse(readFileSync(file, "utf8")) as Summary;
      if (typeof summary.verdict !== "string" || typeof summary.counts !== "object") continue;
      if (!(Date.parse(summary.startedAt) >= jobStartedAt)) continue;
      return summary;
    } catch {
      // Missing or unreadable: try the next one.
    }
  }
  return null;
}

function toResult(summary: Summary, clean: (text: string) => string): NonNullable<Job["result"]> {
  return {
    verdict: summary.verdict === "PASS" ? "PASS" : summary.verdict === "FAIL" ? "FAIL" : "ERROR",
    passed: summary.counts.passed ?? 0,
    failed: summary.counts.failed ?? 0,
    flaky: summary.counts.flaky ?? 0,
    skipped: summary.counts.skipped ?? 0,
    durationMs: summary.durationMs,
    problems: (summary.problems ?? []).map((p) => ({
      severity: p.severity,
      area: clean(p.area),
      headline: clean(p.headline),
      failedStep: p.failedStep === null ? null : clean(p.failedStep),
      details: p.details.map(clean),
      tests: p.tests.map(clean),
      // The screenshot's number only. The file stays in the run's folder (job-images.ts moves it into the store).
      ...(validImageNumber(p.image?.n) ? { image: p.image!.n } : {}),
      ...(typeof p.imageNote === "string" ? { imageNote: clean(p.imageNote) } : {}),
    })),
    runId: summary.runId ?? null,
    ...probeExtras(summary, clean),
  };
}

const validImageNumber = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 999;

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/** Splits a stream into lines. A child that prints without newlines cannot grow memory forever. */
function lineSplitter(onLine: (line: string) => void) {
  let partial = "";
  return {
    write(text: string) {
      partial += text;
      const parts = partial.split("\n");
      partial = parts.pop() ?? "";
      for (const line of parts) onLine(line);
      if (partial.length > 10_000) {
        onLine(partial);
        partial = "";
      }
    },
    end() {
      if (partial) onLine(partial);
      partial = "";
    },
  };
}

/**
 * Stops the child and everything it started. Killing only the child is not
 * enough: the QA runner starts Playwright, which starts a browser, and those
 * would carry on running, holding the browser and the ports the next job needs.
 */
/**
 * The Stop button: ends the running job the same way the time limit does, by
 * stopping its process tree. The job then finishes through the normal path,
 * so its log, chat and summary are kept, with "Stopped by ..." as its error.
 * Returns false when this server is not running that job (already finished,
 * still being created, or run by another console server).
 */
export function stopJob(jobId: string, by: string): boolean {
  const slot = state.active;
  if (!slot || slot.jobId !== jobId || !slot.child) return false;
  if (!slot.stoppedBy) {
    slot.stoppedBy = by;
    stopTree(slot.child);
  }
  return true;
}

function stopTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    // /T takes the whole tree, /F does not wait to be asked twice. Full path, so PATH cannot swap the program.
    const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    spawnSync(taskkill, ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  // The child leads its own process group (detached), and a negative pid
  // signals the whole group. Ask first, then insist.
  const pid = child.pid;
  signalGroup(pid, "SIGTERM");
  setTimeout(() => signalGroup(pid, "SIGKILL"), KILL_GRACE_MS).unref();
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group has already gone.
  }
}

/** If the server itself exits, take the running job with it rather than leave a browser running unwatched. */
function installExitHook(): void {
  if (state.exitHookInstalled) return;
  state.exitHookInstalled = true;
  process.on("exit", () => {
    const child = state.active?.child;
    if (child) stopTree(child);
  });
}

function positiveNumber(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function duration(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}
