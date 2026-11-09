import "server-only";
import type { JobCommit } from "../contract";
import { decryptSecret } from "./encryption";
import { GithubApiError, branchHead, consoleBaseUrl, jobPageUrl, postStatus, type StatusState } from "./github";
import type { GithubLinkRecord, JobRecord } from "./records";
import { startProjectJob } from "./start";
import { getGithubLink, getJob, getProject, listGithubLinks, patchGithubLink } from "./store";

/**
 * The GitHub poller. Every GITHUB_POLL_MS it asks GitHub for the newest commit
 * on each watched branch. A commit it has not seen starts a Probe through the
 * same startProjectJob as the Probe button, so the allow-list and the
 * one-job-at-a-time rule apply unchanged. It reports back to GitHub with
 * commit statuses: pending while the job runs, then success, failure or error.
 *
 * One loop per server process, started from instrumentation.ts.
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
      if (!isWatched(link)) continue;
      await checkWorkspace(link.projectId).catch((err: unknown) => logFailure(link, err));
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
 * Checks one workspace now. Returns the id of the Probe it started, or null
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
  const outcome = await startProjectJob(project, "qa", createdBy, { trigger: "github", commit });

  if ("error" in outcome && outcome.status === 409) {
    // Busy: another job holds the one slot. lastSeenSha stays, and the ETag
    // is dropped so the next tick gets a full answer and sees this commit again.
    await patchGithubLink(projectId, { lastCheckedAt: now, etag: null });
    return null;
  }

  if ("error" in outcome) {
    // Refused for good (403: host not on the allow-list, 422: no QA account,
    // 500: no console key). Retrying would fail the same way every tick, so
    // the commit is marked handled and GitHub is told why.
    await patchGithubLink(projectId, { lastCheckedAt: now, lastSeenSha: head.sha, etag: head.etag });
    await safeStatus(link, token, head.sha, { state: "error", description: outcome.error, targetUrl: projectPageUrl(projectId) });
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
  await safeStatus(link, token, head.sha, { state: "pending", description: "Probe running", targetUrl: jobPageUrl(job.id) });
  return job.id;
}

/** Posts the final status for a GitHub-started job once it has finished. Still running: nothing to do yet. */
async function reportFinished(link: GithubLinkRecord & { repo: string }, token: string, jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (job && (job.status === "queued" || job.status === "running" || job.status === "waiting")) return;
  if (job?.commit) {
    await safeStatus(link, token, job.commit.sha, { ...finalStatus(job), targetUrl: jobPageUrl(job.id) });
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
  link: GithubLinkRecord & { repo: string },
  token: string,
  sha: string,
  status: { state: StatusState; description: string; targetUrl: string },
): Promise<void> {
  await postStatus(token, link.repo, sha, status).catch((err: unknown) => logFailure(link, err));
}

/** One line, never the token: GithubApiError messages are built without it, and other errors carry no request data. */
function logFailure(link: GithubLinkRecord, err: unknown): void {
  const reason = err instanceof GithubApiError || err instanceof Error ? err.message : String(err);
  console.error(`[console] GitHub poll for ${link.repo ?? link.projectId} failed: ${reason}`);
}
