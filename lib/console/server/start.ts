import "server-only";
import type { JobKind, JobOrigin } from "../contract";
import { ConsoleKeyError } from "./encryption";
import { probeRefusal } from "./probe";
import { toProjectDto } from "./projects";
import { MANUAL_ORIGIN, type JobRecord, type ProjectRecord } from "./records";
import { startJob } from "./runner";

/**
 * The checks every job start goes through, whoever asked for it: an employee
 * pressing a button (POST /projects/:id/jobs, POST /projects/:id/github/test)
 * or the GitHub poller. Kept in one place so a GitHub-started Probe can never
 * skip the access rule or the one-job-at-a-time rule, and every route answers
 * with the same status codes and the same words.
 *
 * writes: may this run change data (save, upload, delete)? Every caller
 * decides it on purpose: Explore never, Full access test always, and a run
 * nobody clicked only on an allow-listed host (projects.ts hostAllowsWrites).
 *
 * Returns the started job, or the status and message the route should answer with.
 */
export type StartOutcome = { job: JobRecord } | { status: number; error: string };

/**
 * attended: a signed-in employee started this run and is watching it (the
 * GitHub code test button), so it may ask for a login in the job's chat even
 * though it carries a GitHub commit. The poller and "Check now" leave it out.
 * A run started by hand is always attended. The child learns it from
 * CONSOLE_ATTENDED (runner.ts); only an attended run asks a person to solve a CAPTCHA.
 */
export type StartOptions = { writes: boolean; origin?: JobOrigin; callbackBase?: string; attended?: boolean };

export async function startProjectJob(
  project: ProjectRecord,
  kind: JobKind,
  createdBy: string,
  { writes, origin = MANUAL_ORIGIN, callbackBase, attended = false }: StartOptions,
): Promise<StartOutcome> {
  // A run started by hand may go without saved credentials: it asks for them
  // in the job's chat when it reaches the sign-in screen. A GitHub-started run
  // has nobody to ask, so it still needs them, unless a person started it.
  if (origin.trigger === "github" && !attended && !toProjectDto(project).hasCredentials) {
    return {
      status: 422,
      error:
        "This workspace has no saved QA password and authenticator key, and a GitHub-triggered run has nobody to ask. Start a run by hand and choose Remember for this workspace when it asks.",
    };
  }

  // The safety rule, checked before anything else can happen. On the
  // stand-in the Probe is the built-in suite, which always writes, so a run
  // that may not write is refused. On any other site it is the AI Probe,
  // which skips steps that change data when it may not write, so it is
  // allowed anywhere; it only needs a model key or a recorded plan (probe.ts).
  // Explore is read-only and is allowed against any target.
  if (kind === "qa") {
    const refusal = await probeRefusal(project, writes);
    if (refusal) return refusal;
  }

  try {
    const watched = origin.trigger !== "github" || attended;
    const started = await startJob(project, kind, createdBy, origin, callbackBase, kind === "qa" && writes, watched);
    if ("busy" in started) return { status: 409, error: started.busy };
    return { job: started.job };
  } catch (err) {
    if (err instanceof ConsoleKeyError) return { status: 500, error: err.message };
    // The message is logged for whoever runs the server; it never contains a
    // credential, because those are only ever passed to the child's environment.
    console.error("[console] Could not start a job:", err instanceof Error ? err.message : err);
    return { status: 500, error: "The job could not be started. The server log has the reason." };
  }
}
