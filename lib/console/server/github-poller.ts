import "server-only";
import type { JobCommit } from "../contract";
import { decryptSecret } from "./encryption";
import { GithubApiError, branchHead, consoleBaseUrl, jobPageUrl, postStatus, repoOfCommitUrl, type StatusState } from "./github";
import { hostAllowsWrites } from "./projects";
import type { GithubLinkRecord, JobRecord } from "./records";
import { startProjectJob, type StartOutcome } from "./start";
import { getGithubLink, getJob, getProject, listGithubLinks, patchGithubLink } from "./store";

/**
 * The GitHub poller. Every GITHUB_POLL_MS it asks GitHub for the newest commit
 * on each watched branch. A commit it has not seen starts a Probe through the
 * same startProjectJob as the Probe buttons, so the one-job-at-a-time rule
 * applies unchanged. Nobody chose its access, so it may change data only on
 * an allow-listed host (projects.ts hostAllowsWrites), whatever the stored
 * Full access switch says. It reports back to GitHub with commit statuses:
 * pending while the job runs, then success, failure or error.
 *
 * The GitHub code test (testCommit) starts its Probe the same way, for a repo
 * that need not be the watched one. The final status goes to the repo in the
 * job's commit link, so it lands on the right repo either way.
 *
 * One loop per server process, started from instrumentation.ts.
 *
 * Workspaces with "Check every new commit" off are skipped, apart from
 * posting the final status of a run that started before it was turned off.
 *
 * Several console servers on one Supabase database would each poll. The
 * runner's database check stops two jobs running at once, but to be sure only
 * one server polls, set GITHUB_POLL_MS=0 on the others, which turns this off.
 */

const DEFAULT_POLL_MS = 60_000;
/** Faster than this would spend the rate limit for nothing. */
const MIN_POLL_MS = 10_000;

type PollerState = {
  started: boolean;
  /** Workspaces being checked right now, so a tick and the "check now" button never run one twice at once. */
  checking: Set<string>;
  ticking: boolean;
};

/** On globalThis, so a hot reload in development does not start a second loop. */
const globalForPoller = globalThis as unknown as { __eclypseGithubPoller?: PollerState };
const state: PollerState = (globalForPoller.__eclypseGithubPoller ??= {
  started: false,
  checking: new Set(),
  ticking: false,
});

export function startGithubPoller(): void {
  if (state.started) return;
  state.started = true;
  const raw = process.env.GITHUB_POLL_MS?.trim();
  if (raw === "0") return; // turned off on purpose, see above
  const parsed = Number(raw);
  const every = raw && Number.isFinite(parsed) && parsed > 0 ? Math.max(parsed, MIN_POLL_MS) : DEFAULT_POLL_MS;
  // unref: a pending tick never keeps the process alive on shutdown.
  setInterval(() => void tick(), every).unref();
}

/** One pass over every watched workspace. A failure on one is logged and the rest still run. */
async function tick(): Promise<void> {
  if (state.ticking) return; // the last pass is still going, GitHub is slow
  state.ticking = true;
  try {
    for (const link of await listGithubLinks()) {
      if (!isWatched(link)) {
        // Not watching a branch, but a code test may still need its final status.
        if (link.tokenEnc && link.pendingJobId) await finishPending(link.projectId).catch((err: unknown) => logFailure(link, err));
        continue;
      }
      // Switch off: no new runs, but a run already started still gets its final status.
      const work = link.autoCheck === false ? finishPending(link.projectId) : checkWorkspace(link.projectId);
      await work.catch((err: unknown) => logFailure(link, err));
    }
  } catch (err) {
    console.error("[console] GitHub poll could not list workspaces:", err instanceof Error ? err.message : err);
  } finally {
    state.ticking = false;
  }
}

type WatchedLink = GithubLinkRecord & { tokenEnc: string; repo: string; branch: string };

/** Has a token, a repo and a branch: the poller has something to look at. */
export function isWatched(link: GithubLinkRecord | undefined): link is WatchedLink {
  return Boolean(link?.tokenEnc && link.repo && link.branch);
}

/**
 * Checks one workspace now, whatever the switch says (the "Check now" button). Returns the id of the Probe it started, or null
 * when there was nothing new (or the console was busy, in which case the next
 * tick tries again). Throws on a GitHub or database failure; the tick logs
 * it, the "check now" route reports it.
 */
export async function checkWorkspace(projectId: string): Promise<string | null> {
  if (state.checking.has(projectId)) return null;
  state.checking.add(projectId);
  try {
    return await check(projectId);
  } finally {
    state.checking.delete(projectId);
  }
}

/** For a workspace with the switch off, or with no watched branch: only posts the final status of a run started earlier. */
async function finishPending(projectId: string): Promise<void> {
  if (state.checking.has(projectId)) return;
  state.checking.add(projectId);
  try {
    const link = await getGithubLink(projectId);
    if (link?.tokenEnc && link.pendingJobId) await reportFinished(link, decryptSecret(link.tokenEnc), link.pendingJobId);
  } finally {
    state.checking.delete(projectId);
  }
}

async function check(projectId: string): Promise<string | null> {
  const link = await getGithubLink(projectId);
  if (!isWatched(link)) return null;
  const token = decryptSecret(link.tokenEnc);

  // First, close off the last GitHub-started job if it has finished since.
  if (link.pendingJobId) await reportFinished(link, token, link.pendingJobId);

  const head = await branchHead(token, link.repo, link.branch, link.etag);
  const now = Date.now();
  if ("missing" in head) {
    console.error(`[console] GitHub poll: branch ${link.branch} of ${link.repo} not found or not visible to this token.`);
    await patchGithubLink(projectId, { lastCheckedAt: now });
    return null;
  }
  if (!head.changed || head.sha === link.lastSeenSha) {
    await patchGithubLink(projectId, { lastCheckedAt: now, ...(head.changed ? { etag: head.etag } : {}) });
    return null;
  }

  const project = await getProject(projectId);
  if (!project) return null;
  const commit: JobCommit = { sha: head.sha, ref: link.branch, runUrl: head.htmlUrl };
  const createdBy = link.account ? `github:${link.account}` : "github";
  const outcome = await startProjectJob(project, "qa", createdBy, {
    writes: hostAllowsWrites(project.targetUrl),
    origin: { trigger: "github", commit },
  });

  if ("error" in outcome && outcome.status === 409) {
    // Busy: another job holds the one slot. lastSeenSha stays, and the ETag
    // is dropped so the next tick gets a full answer and sees this commit again.
    await patchGithubLink(projectId, { lastCheckedAt: now, etag: null });
    return null;
  }

  if ("error" in outcome) {
    // Refused for good (403: read-only on the stand-in, 422: no QA account,
    // 500: no console key). Retrying would fail the same way every tick, so
    // the commit is marked handled and GitHub is told why.
    await patchGithubLink(projectId, { lastCheckedAt: now, lastSeenSha: head.sha, etag: head.etag });
    await safeStatus(link, token, link.repo, head.sha, { state: "error", description: outcome.error, targetUrl: projectPageUrl(projectId) });
    return null;
  }

  const job = outcome.job;
  await patchGithubLink(projectId, {
    lastCheckedAt: now,
    lastSeenSha: head.sha,
    lastTriggeredAt: now,
    etag: head.etag,
    pendingJobId: job.id,
  });
  await safeStatus(link, token, link.repo, head.sha, { state: "pending", description: "Probe running", targetUrl: jobPageUrl(job.id) });
  return job.id;
}

/**
 * The GitHub code test: a Probe for the newest commit on one branch of a repo
 * the route has already checked the account can push to. Started and
 * reported like a watched branch's new commit, but the watched repo, branch,
 * last seen commit and ETag stay as they are. Only pendingJobId is set, so
 * the poller posts the final status. Throws on a GitHub or database failure.
 */
export async function testCommit(projectId: string, repo: string, branch: string, createdBy: string): Promise<StartOutcome> {
  if (state.checking.has(projectId)) {
    return { status: 409, error: "GitHub is being checked for this workspace right now. Try again in a moment." };
  }
  state.checking.add(projectId);
  try {
    const link = await getGithubLink(projectId);
    const project = await getProject(projectId);
    if (!link?.tokenEnc || !project) return { status: 404, error: "Project not found." };
    const token = decryptSecret(link.tokenEnc);

    // Close off the last GitHub-started job first, as check does, so its final status is not lost.
    if (link.pendingJobId) await reportFinished(link, token, link.pendingJobId);

    const head = await branchHead(token, repo, branch, null);
    if ("missing" in head) return { status: 422, error: `Could not find branch ${branch} in ${repo}.` };
    if (!head.changed) return { status: 502, error: "GitHub gave no answer for that branch. Try again." };

    const commit: JobCommit = { sha: head.sha, ref: branch, runUrl: head.htmlUrl };
    // attended: the employee who pressed the button is watching, so the run may ask for a login in the chat.
    const outcome = await startProjectJob(project, "qa", createdBy, {
      writes: hostAllowsWrites(project.targetUrl),
      origin: { trigger: "github", commit },
      attended: true,
    });
    if ("error" in outcome) return outcome;

    await patchGithubLink(projectId, { pendingJobId: outcome.job.id });
    await safeStatus(link, token, repo, head.sha, { state: "pending", description: "Probe running", targetUrl: jobPageUrl(outcome.job.id) });
    return outcome;
  } finally {
    state.checking.delete(projectId);
  }
}

/**
 * Posts the final status for a GitHub-started job once it has finished. Still running: nothing to do yet.
 * The repo comes from the job's commit link, so a code test reports to its own repo, not the watched one.
 */
async function reportFinished(link: GithubLinkRecord, token: string, jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (job && (job.status === "queued" || job.status === "running" || job.status === "waiting")) return;
  const repo = repoOfCommitUrl(job?.commit?.runUrl) ?? link.repo;
  if (job?.commit && repo) {
    await safeStatus(link, token, repo, job.commit.sha, { ...finalStatus(job), targetUrl: jobPageUrl(job.id) });
  }
  await patchGithubLink(link.projectId, { pendingJobId: null });
}

function finalStatus(job: JobRecord): { state: StatusState; description: string } {
  const counts = job.result ? `${job.result.passed} passed, ${job.result.failed} failed` : "";
  if (job.status === "passed") return { state: "success", description: `PASS: ${counts}` };
  if (job.status === "failed") return { state: "failure", description: `FAIL: ${counts}` };
  return { state: "error", description: job.error ?? "The Probe could not finish." };
}

/** The workspace's GitHub page, for statuses that have no job to link to. */
function projectPageUrl(projectId: string): string {
  return `${consoleBaseUrl()}/console/projects/${projectId}/github`;
}

/**
 * A commit status that cannot be posted (no write access on the repo, GitHub
 * down) is logged, not thrown: the job itself is fine, and the bookkeeping
 * around it must still be saved.
 */
async function safeStatus(
  link: GithubLinkRecord,
  token: string,
  repo: string,
  sha: string,
  status: { state: StatusState; description: string; targetUrl: string },
): Promise<void> {
  await postStatus(token, repo, sha, status).catch((err: unknown) => logFailure(link, err));
}

/** One line, never the token: GithubApiError messages are built without it, and other errors carry no request data. */
function logFailure(link: GithubLinkRecord, err: unknown): void {
  const reason = err instanceof GithubApiError || err instanceof Error ? err.message : String(err);
  console.error(`[console] GitHub poll for ${link.repo ?? link.projectId} failed: ${reason}`);
}
