import "server-only";
import type { JobKind, JobOrigin } from "../contract";
import { ConsoleKeyError } from "./encryption";
import { qaRunRefusal, toProjectDto } from "./projects";
import { MANUAL_ORIGIN, type JobRecord, type ProjectRecord } from "./records";
import { startJob } from "./runner";

/**
 * The checks every job start goes through, whoever asked for it: an employee
 * pressing a button (POST /projects/:id/jobs) or GitHub Actions
 * (POST /projects/:id/trigger). Kept in one place so a GitHub-triggered Probe
 * can never skip the allow-list or the one-job-at-a-time rule, and both
 * routes answer with the same status codes and the same words.
 *
 * Returns the started job, or the status and message the route should answer with.
 */
export type StartOutcome = { job: JobRecord } | { status: number; error: string };

export async function startProjectJob(
  project: ProjectRecord,
  kind: JobKind,
  createdBy: string,
  origin: JobOrigin = MANUAL_ORIGIN,
  callbackBase?: string,
): Promise<StartOutcome> {
  // A run started by hand may go without saved credentials: it asks for them
  // in the job's chat when it reaches the sign-in screen. A GitHub-started run
  // has nobody to ask, so it still needs them.
  if (origin.trigger === "github" && !toProjectDto(project).hasCredentials) {
    return {
      status: 422,
      error:
        "This workspace has no saved QA password and authenticator key, and a GitHub-triggered run has nobody to ask. Start a run by hand and choose Remember for this workspace when it asks.",
    };
  }

  // The safety rule, checked before anything else can happen: a QA run
  // writes and deletes data, so it only goes to a host someone listed on
  // purpose. Explore is read-only and is allowed against any target.
  if (kind === "qa") {
    const refusal = qaRunRefusal(project.targetUrl);
    if (refusal) return { status: 403, error: refusal };
  }

  try {
    const started = await startJob(project, kind, createdBy, origin, callbackBase);
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
