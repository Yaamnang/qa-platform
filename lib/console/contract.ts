/**
 * The QA console: the contract between its API routes and its pages.
 *
 * The console is Eclypse's internal tool. Employees sign in here, add a project
 * (one target URL plus the QA account to use on it), explore it, and run QA
 * against it. It is a separate area from the stand-in platform: its own
 * employee table, its own sign-in, its own session cookie. An employee is never
 * a user of the platform under test, and the QA bot is never an employee.
 *
 * Both the API (app/api/console/**) and the pages (app/console/**) import these
 * types. Change them here and nowhere else.
 */

/** Cookie names are deliberately different from the stand-in's: cookies ignore ports. */
export const CONSOLE_SESSION_COOKIE = "console_session";
export const CONSOLE_CHALLENGE_COOKIE = "console_challenge";

/** What each job kind is called on the pages. */
export const JOB_KIND_LABEL: Record<JobKind, string> = { explore: "Explore", qa: "Probe" };

export type Employee = { id: string; email: string; displayName: string };

/** Never contains the QA account's password or TOTP secret, only whether they are set. */
export type Project = {
  id: string;
  name: string;
  targetUrl: string;
  qaEmail: string;
  hasCredentials: boolean;
  /**
   * True when the target's host is on the allow-list (this machine). There a
   * run started from GitHub may change data, and Full access test needs no confirm.
   */
  qaRunAllowed: boolean;
  /** The old stored "Full access" switch. Kept, but no longer read: access is chosen per run. */
  fullAccess: boolean;
  createdAt: number;
  createdBy: string;
};

export type JobKind = "explore" | "qa";
/** Per Probe run: "read" never changes data, "full" may save, upload and delete. */
export type JobAccess = "read" | "full";
/** "waiting": the run asked the employee something (a login, a code) and is paused until they answer. */
export type JobStatus = "queued" | "running" | "waiting" | "passed" | "failed" | "error";

/** What a run can ask the employee for. login: email and password. code: a one-time code or the authenticator setup key. */
export type AskKind = "login" | "code" | "text";

/** A question from the run. Never holds the answer: secrets stay out of the transcript. */
export type ChatAsk = {
  id: string;
  kind: AskKind;
  prompt: string;
  answered: boolean;
  /** True when the run stopped waiting (no answer in time, or the job ended) before anyone answered. */
  expired?: boolean;
};

/**
 * One line of a job's chat. from "run" is the run itself, "employee" is a
 * person on the job page, "system" is the console. A login or code answer is
 * recorded as "Login provided" or "Code provided", never as the value.
 */
export type ChatMessage = {
  id: string;
  at: number;
  from: "run" | "employee" | "system";
  text: string;
  ask?: ChatAsk;
};

/** One proposed check from the explorer. Mirrors qa/explore/types.ts. */
export type Proposal = {
  id: string;
  journey: string;
  area: string;
  severity: string;
  steps: string[];
  expectations: string[];
};

/** One problem from a QA run. Mirrors the "problems" entries in a run's summary.json. */
export type RunProblem = {
  severity: string;
  area: string;
  headline: string;
  failedStep: string | null;
  details: string[];
  tests: string[];
  /**
   * The number of the screenshot taken when it failed. For a console run the
   * image itself is in the store (GET /api/console/jobs/:id/images/:n), not on
   * disk. Missing on older jobs and when no image was taken.
   */
  image?: number;
  /** Why there is no image, for example on a sign-in step. */
  imageNote?: string;
};

export type Job = {
  id: string;
  projectId: string;
  kind: JobKind;
  status: JobStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  createdBy: string;
  /** Last lines of the child process output, secrets redacted. For the live progress view. */
  logTail: string;
  /** explore jobs: the proposals, once finished. */
  proposals: Proposal[] | null;
  /** explore jobs: which proposals an employee has approved. */
  approvedProposalIds: string[];
  /** qa jobs: pass/fail counts and problems, once finished. */
  result: {
    verdict: "PASS" | "FAIL" | "ERROR";
    passed: number;
    failed: number;
    flaky: number;
    skipped: number;
    durationMs: number;
    problems: RunProblem[];
    runId: string | null;
    /** AI Probe only: the per-journey breakdown. Absent for the built-in suite. */
    journeys?: ProbeJourneyResult[];
    /** AI Probe only: whether it planned with Claude or replayed the recorded plan, and what that cost. */
    probe?: ProbeRunInfo | null;
  } | null;
  /** Human-readable reason when status is "error". */
  error: string | null;
  /**
   * explore jobs: how the explorer ran, once finished. Optional because older
   * jobs, and jobs stored on Supabase (no column for it yet), do not have it.
   */
  explorer?: JobExplorer | null;
  /** The job's chat, oldest first. Empty for jobs from before the chat existed. */
  messages: ChatMessage[];
  /**
   * A short plain-English account of a finished job, built once when it ends
   * (lib/console/server/summary.ts). Advisory only: it never changes the verdict.
   * null while the job runs, and for jobs from before summaries existed.
   */
  summary: JobSummary | null;
};

/** by: "claude" when Claude Haiku wrote it, "template" when it was built from the facts without a model. */
/**
 * One thing worth acting on, sorted by where the fix belongs. product: the site
 * under test is broken. test: the check or its data is wrong. environment: the
 * site, network, login or server could not be used. Advisory only, like the text.
 */
export type TriageItem = {
  category: "product" | "test" | "environment";
  /** What is wrong, one sentence. */
  point: string;
  /** The log lines or facts it rests on, quoted with their times. */
  evidence: string;
  /** One concrete action. */
  nextStep: string;
};

/** triage is missing on summaries written before it existed, and empty when nothing needs acting on. */
export type JobSummary = { text: string; by: "claude" | "template"; triage?: TriageItem[] };

/** Mirrors ExplorerSummary in qa/explore/types.ts. */
export type JobExplorer = {
  /** rules: built-in crawler, no model. claude: Claude drove the read-only browser. replay: recorded decisions, no spend. */
  mode: "rules" | "claude" | "replay";
  model: string;
  steps: number;
  tokens: { input: number; output: number };
  /** Approximate, from hard-coded list prices. */
  approxCostUsd: number;
};

// ---------------------------------------------------------------------------
// API shapes. Every route returns JSON. Errors are { error: string } with a
// meaningful status code.
// ---------------------------------------------------------------------------

// POST /api/console/auth/login        { email, password }        -> { next: "verify" | "setup" }
// GET  /api/console/auth/setup                                    -> { email, secret, otpauthUri, qrSvg }
// POST /api/console/auth/setup        { code }                    -> { next: "/console" }
// POST /api/console/auth/verify       { code }                    -> { next: "/console" }
// POST /api/console/auth/logout                                   -> { ok: true }
// GET  /api/console/me                                            -> { employee: Employee }

// GET  /api/console/projects                                      -> { projects: Array<Project & { lastJob: Job | null }> }
// POST /api/console/projects
//      { name, targetUrl, qaEmail, qaPassword, qaTotpSecret }      -> 201 { project: Project }
//      The QA account fields are optional. A run without them asks for them in the job's chat.
// GET  /api/console/projects/:id                                  -> { project: Project, jobs: Job[] }
// PATCH /api/console/projects/:id { fullAccess: boolean }         -> { project: Project }
//      Stores the old Full access switch. No page uses it and no run reads it any more.
//      409 while a run on this workspace is queued, running or waiting.

// POST /api/console/projects/:id/jobs { kind: JobKind, access?: JobAccess } -> 202 { job: Job }
//      access is for kind "qa" only, default "read". "read" never changes data on any host;
//      "full" may save, upload and delete, and who started it is logged.
//      400 if access is anything else.
//      409 if a job is already running anywhere (one at a time: one browser, one port).
//      403 if kind is "qa", access is "read" and the target is the stand-in, whose built-in suite always writes.
// GET  /api/console/jobs/:id                                      -> { job: Job }
// POST /api/console/jobs/:id/stop                                 -> 202 { ok: true }
//      Stops a running job. It ends as "error" with "Stopped by <email>", keeping its log, chat and summary.
//      409 if it has already finished, or is still starting.
// PUT  /api/console/jobs/:id/approvals { approvedProposalIds }     -> { job: Job }
// GET  /api/console/jobs/:id/draft                                -> text/plain draft spec of approved proposals only
// GET  /api/console/jobs/:id/report                               -> text/html probe-report-<id>.html, one self-contained file
//      A finished Probe job: verdict, counts, each problem with its image embedded, fixes needed, log tail.
//      409 if the job is not a finished Probe job.
// GET  /api/console/jobs/:id/images/:n                             -> image/jpeg or image/png, problem image n
//      Read from the store. 404 if the job has no such image, or it was not saved.
// POST /api/console/jobs/:id/messages { text }                     -> { job: Job }
//      A steering message from the employee while the job runs. The explorer reads them before its next step.
// POST /api/console/jobs/:id/answer { askId, values, remember? }   -> { job: Job }
//      values: login { email, password }, code { code } (6 digits) or { totpSecret }, text { text }.
//      remember: true saves a login or totpSecret encrypted on the workspace for later and unattended runs.
//      The values are held in server memory only until the run collects them, then dropped.
//
// The run's own side of the chat, used by qa/lib/console-link.ts inside the job's
// child processes. Authenticated only by "Authorization: Bearer <job token>", a
// random token made per job (only its hash is kept). A wrong token gets 404.
// POST /api/console/jobs/:id/agent/say   { text, event? }          -> { ok: true }
// POST /api/console/jobs/:id/agent/ask   { kind, prompt, event? }  -> { askId }
// GET  /api/console/jobs/:id/agent/ask?id=<askId>                  -> { state: "pending" | "answered" | "closed", values? }
// DELETE /api/console/jobs/:id/agent/ask?id=<askId>                -> { ok: true }   the run gave up waiting
// GET  /api/console/jobs/:id/agent/inbox                           -> { messages: string[] }   steering messages since the last call

// ---------------------------------------------------------------------------
// Workspace navigation and GitHub (added). In the UI "Run QA" is now called
// "Probe": the real-user run. The API kind stays "qa" so nothing else moves.
//
// Pages, each with the same left navbar (Explore, Probe, GitHub):
//   /console/projects/:id            redirects to /console/projects/:id/probe
//   /console/projects/:id/explore    start Explore, explore history
//   /console/projects/:id/probe      start Probe, probe history
//   /console/projects/:id/github     connect GitHub, the auto check switch, GitHub-triggered runs
// ---------------------------------------------------------------------------

/** Where a job came from. Present on every Job from now on; old rows read as "manual". */
export type JobTrigger = "manual" | "github";

/** For GitHub-triggered jobs: the commit that caused the run. */
export type JobCommit = { sha: string; ref: string; runUrl: string | null };

/** Extra Job fields, merged into Job by the API. */
export type JobOrigin = { trigger: JobTrigger; commit: JobCommit | null };

/**
 * A workspace's GitHub connection. An employee pastes a GitHub personal access
 * token of their own (scope "repo"), picks a repo and branch, and the console
 * polls that branch. Nothing has to be installed on the repo: no app, webhook,
 * secret or OAuth app, so a collaborator without admin rights can use it, and
 * it works when the console runs on localhost. Never contains the token.
 */
export type GithubLink = {
  /** Where to create a token with the right permission: a fixed GitHub link. */
  tokenUrl: string;
  /** The console holds a GitHub token for this workspace. */
  connected: boolean;
  /** GitHub login of whoever connected. */
  account: string | null;
  /** "owner/name" being watched. */
  repo: string | null;
  branch: string | null;
  lastCheckedAt: number | null;
  lastSeenSha: string | null;
  lastTriggeredAt: number | null;
  /** "Check every new commit". On by default. Off: nothing runs by itself, Check now still works. */
  autoCheck: boolean;
};

/** The code test's answer when the workspace has no GitHub token. The page shows a link to the GitHub tab for it. */
export const GITHUB_NOT_CONNECTED = "Connect GitHub first.";

export type GithubRepo = { fullName: string; private: boolean; defaultBranch: string; pushedAt: number | null };

// All of these need an employee session.
// GET    /api/console/projects/:id/github                  -> { github: GithubLink }
// PUT    /api/console/projects/:id/github/token { token }  -> { github: GithubLink }
//        Checks the token with GitHub (GET /user), then stores it encrypted.
//        422 "GitHub did not accept that token." when GitHub answers 401.
//        422 "That token is missing the repo permission. Create it with the
//        link on this page." when GitHub lists its scopes and "repo" is not one.
// GET    /api/console/projects/:id/github/repos            -> { repos: GithubRepo[] }
//        Repos the token can see, up to 200, most recently pushed first.
// PUT    /api/console/projects/:id/github { repo, branch } -> { github: GithubLink }
//        Starts watching. The branch's current head becomes lastSeenSha, so
//        connecting does not start a run; the next new commit does.
// PATCH  /api/console/projects/:id/github { autoCheck }    -> { github: GithubLink }
//        Turns "Check every new commit" on or off. Needs a repo and branch.
//        500 with "Run db/schema-console.sql ..." when the column is missing.
// POST   /api/console/projects/:id/github/check            -> { github: GithubLink, startedJobId: string | null }
//        Polls now instead of waiting for the next tick (for demos).
// POST   /api/console/projects/:id/github/test { repoUrl } -> 202 { job: Job }
//        The GitHub code test: a Probe for the newest commit on the default branch
//        of any repo the connected account can push to. Commit statuses as for a
//        watched branch. Does not change the watched repo or branch. Read-only
//        unless the host is on the allow-list.
//        409 GITHUB_NOT_CONNECTED without a token, 409 when a job is running,
//        400 for a link that is not https://github.com/owner/repo,
//        403 "You are not a collaborator on owner/repo." without push access,
//        422 for a missing default branch. Needs no saved login: the employee is
//        watching, so the run may ask for it in the job's chat.
// DELETE /api/console/projects/:id/github                  -> { github: GithubLink }
//        Forgets the token and the repo.
//
// The poller checks every watched branch with autoCheck on every GITHUB_POLL_MS (default 60000).
// A new commit starts a Probe (kind "qa") with trigger "github", under the same
// one-job-at-a-time rule as a manual Probe. Nobody chose its access, so it may
// change data only on an allow-listed host (Project.qaRunAllowed). It posts a commit
// status ("Eclypse QA") on GitHub: pending while it runs, then success, failure
// or error, linking to the job page.

// ---------------------------------------------------------------------------
// Live view (added). What the QA browser sees, shown on the job page.
//
// Sent by the run (Bearer job token, same as the other agent routes):
// POST /api/console/jobs/:id/agent/frame   body: image/jpeg bytes
//      headers: X-Live-Url, X-Live-Label (no secrets), X-Live-Box (JSON {x,y,width,height} in page pixels, optional),
//               X-Live-Viewport (JSON {width,height})
//      The server keeps only the latest frame per job, in memory, and drops it when the job ends.
//      X-Live-Url and X-Live-Label are URI-encoded (encodeURIComponent). Frames over 600 KB get 413.
// Read by the employee (session):
// GET  /api/console/jobs/:id/frame       -> image/jpeg, Cache-Control: no-store; 204 when there is no frame yet
// GET  /api/console/jobs/:id/frame/meta  -> { frame: LiveFrameMeta | null }
// ---------------------------------------------------------------------------

export type LiveFrameMeta = {
  seq: number;
  at: number;
  url: string;
  label: string | null;
  box: { x: number; y: number; width: number; height: number } | null;
  viewport: { width: number; height: number };
};

// ---------------------------------------------------------------------------
// AI Probe (added). Mirrors qa/probe/types.ts. A Probe on the stand-in runs the
// built-in suite; on any other site it runs the AI Probe: Claude Haiku plans a
// few journeys once, the plan is recorded on the workspace and replayed later
// with no model call, and every verdict comes from deterministic checks.
//
// GET    /api/console/projects/:id/probe-plan  -> { probe: "builtin" | "ai", plan: ProbePlanInfo | null, hasKey: boolean }
// DELETE /api/console/projects/:id/probe-plan  -> { plan: null }   "Re-plan": the next Probe plans again
// ---------------------------------------------------------------------------

export type ProbeStepResult = {
  title: string;
  action: string;
  expect: string;
  status: "passed" | "failed" | "skipped" | "not-run";
  reason: string | null;
  durationMs: number;
};

export type ProbeJourneyResult = {
  name: string;
  start: string;
  outcome: "passed" | "failed" | "flaky" | "skipped";
  headline: string | null;
  failedStep: string | null;
  steps: ProbeStepResult[];
  durationMs: number;
};

export type ProbeRunInfo = {
  mode: "planned" | "recorded";
  model: string;
  journeys: number;
  steps: number;
  tokens: { input: number; output: number };
  approxCostUsd: number;
  readOnly: boolean;
};

export type ProbePlanInfo = { journeys: string[]; steps: number; model: string; createdAt: string };
