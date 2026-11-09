import "server-only";
import type { GithubLink, GithubRepo } from "../contract";
import type { GithubLinkRecord } from "./records";

/**
 * GitHub for the console: checking a pasted token, the few REST calls the
 * poller needs, and what a browser may see of a connection.
 *
 * Why the employee's own personal access token, and polling: the person
 * setting this up may only be a collaborator on the client's repo. Installing
 * an app, adding a webhook or a repo secret all need admin rights. Reading
 * commits and posting commit statuses only need write access, which a
 * collaborator has. A pasted token also needs no OAuth app to be registered
 * first. Polling works when the console runs on localhost, where a webhook
 * from GitHub could never arrive.
 *
 * The token never leaves this server: it is stored encrypted, sent only to
 * api.github.com, and never put in a log line, an error message or a response.
 */

const API = "https://api.github.com";

/** Opens GitHub's "new token" page with the repo scope already ticked. */
export const TOKEN_URL = "https://github.com/settings/tokens/new?scopes=repo&description=Eclypse%20QA%20console";
/** Every GitHub call gives up after this, so one slow answer cannot stall the poller. */
const TIMEOUT_MS = 15_000;
/** Commit status descriptions are cut by GitHub at 140 characters; cut them here so the end is ours. */
const STATUS_DESCRIPTION_MAX = 140;

export const STATUS_CONTEXT = "Eclypse QA";

/** A GitHub call that failed. The message is safe to log and to show: it never contains the token. */
export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * The console's own address, for the job links in commit statuses.
 * CONSOLE_PUBLIC_URL when deployed, else this machine. A fixed value rather
 * than a request's origin, because the poller has no request.
 */
export function consoleBaseUrl(): string {
  const configured = process.env.CONSOLE_PUBLIC_URL?.trim().replace(/\/+$/, "");
  return configured || `http://localhost:${process.env.PORT || 3000}`;
}

export const jobPageUrl = (jobId: string) => `${consoleBaseUrl()}/console/jobs/${jobId}`;

/** What a browser may see: everything except the token, the ETag and the pending job bookkeeping. */
export function toGithubLinkDto(link: GithubLinkRecord | undefined): GithubLink {
  return {
    tokenUrl: TOKEN_URL,
    connected: Boolean(link?.tokenEnc),
    account: link?.account ?? null,
    repo: link?.repo ?? null,
    branch: link?.branch ?? null,
    lastCheckedAt: link?.lastCheckedAt ?? null,
    lastSeenSha: link?.lastSeenSha ?? null,
    lastTriggeredAt: link?.lastTriggeredAt ?? null,
  };
}

/** GitHub's own rules, loosely: owner/name of letters, digits, dot, dash and underscore. Also keeps the URL path safe. */
export function isRepoName(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value);
}

/** Branch names may contain slashes. Refused: spaces, control characters, "..", and anything that would break a URL path. */
export function isBranchName(value: string): boolean {
  return value.length > 0 && value.length <= 255 && !/[\s~^:?*[\\\x00-\x1f]|\.\.|^\/|\/$/.test(value);
}

// ---------------------------------------------------------------------------
// REST calls
// ---------------------------------------------------------------------------

function api(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "eclypse-qa-console",
      authorization: `Bearer ${token}`,
      ...init.headers,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
}

/** One plain sentence per failure. 401 gets its own, because the fix is to connect again. */
function failed(what: string, res: Response): GithubApiError {
  if (res.status === 401) return new GithubApiError(401, "GitHub no longer accepts this connection. Connect GitHub again.");
  return new GithubApiError(res.status, `GitHub ${what} failed with HTTP ${res.status}.`);
}

/**
 * Checks a pasted token and says whose it is.
 *
 * Classic tokens come back with an X-OAuth-Scopes header listing what they
 * may do; without "repo" the console could neither see a private repo nor post
 * a commit status. Fine-grained tokens send no such header, so for them this
 * check is skipped and a missing permission shows up later as a failed call.
 */
export async function checkToken(token: string): Promise<{ login: string } | { refused: string }> {
  const res = await api(token, "/user");
  if (res.status === 401) return { refused: "GitHub did not accept that token." };
  if (!res.ok) throw failed("token check", res);
  const scopes = res.headers.get("x-oauth-scopes");
  if (scopes !== null && !scopes.split(",").map((scope) => scope.trim()).includes("repo")) {
    return { refused: "That token is missing the repo permission. Create it with the link on this page." };
  }
  return { login: ((await res.json()) as { login: string }).login };
}

/** Two pages of 100 cover the contract's "up to 200". GitHub sorts by last push for us. */
export async function listRepos(token: string): Promise<GithubRepo[]> {
  const repos: GithubRepo[] = [];
  for (const page of [1, 2]) {
    const res = await api(token, `/user/repos?per_page=100&page=${page}&sort=pushed&direction=desc`);
    if (!res.ok) throw failed("repo list", res);
    type Row = { full_name: string; private: boolean; default_branch: string; pushed_at: string | null };
    const rows = (await res.json()) as Row[];
    for (const row of rows) {
      repos.push({
        fullName: row.full_name,
        private: row.private,
        defaultBranch: row.default_branch,
        pushedAt: row.pushed_at ? Date.parse(row.pushed_at) : null,
      });
    }
    if (rows.length < 100) break;
  }
  return repos;
}

export type BranchHead =
  | { changed: false }
  | { changed: true; sha: string; htmlUrl: string; etag: string | null }
  | { missing: true };

/**
 * The newest commit on a branch. Asks for the bare sha (vnd.github.sha) rather
 * than the full commit, which carries the whole diff. With an ETag from last
 * time, an unchanged branch answers 304, which GitHub does not count against
 * the rate limit.
 */
export async function branchHead(token: string, repo: string, branch: string, etag: string | null): Promise<BranchHead> {
  const ref = branch.split("/").map(encodeURIComponent).join("/");
  const res = await api(token, `/repos/${repo}/commits/${ref}`, {
    headers: { accept: "application/vnd.github.sha", ...(etag ? { "if-none-match": etag } : {}) },
  });
  if (res.status === 304) return { changed: false };
  if (res.status === 404 || res.status === 422) return { missing: true };
  if (!res.ok) throw failed("branch lookup", res);
  const sha = (await res.text()).trim();
  // The same address as the commit's html_url, built here because the bare-sha answer does not include it.
  return { changed: true, sha, htmlUrl: `https://github.com/${repo}/commit/${sha}`, etag: res.headers.get("etag") };
}

export type StatusState = "pending" | "success" | "failure" | "error";

/** A commit status: the dot GitHub shows next to the commit and on pull requests. Needs write access, not admin. */
export async function postStatus(
  token: string,
  repo: string,
  sha: string,
  status: { state: StatusState; description: string; targetUrl: string },
): Promise<void> {
  const description =
    status.description.length > STATUS_DESCRIPTION_MAX
      ? `${status.description.slice(0, STATUS_DESCRIPTION_MAX - 3)}...`
      : status.description;
  const res = await api(token, `/repos/${repo}/statuses/${sha}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state: status.state, description, target_url: status.targetUrl, context: STATUS_CONTEXT }),
  });
  if (!res.ok) throw failed("commit status", res);
}
