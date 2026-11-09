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

export type Employee = { id: string; email: string; displayName: string };

/** Never contains the QA account's password or TOTP secret, only whether they are set. */
export type Project = {
  id: string;
  name: string;
  targetUrl: string;
  qaEmail: string;
  hasCredentials: boolean;
  /** True when this host is on CONSOLE_QA_HOSTS, so a full QA run (which writes data) is allowed. */
  qaRunAllowed: boolean;
  createdAt: number;
  createdBy: string;
};

export type JobKind = "explore" | "qa";
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
export type JobSummary = { text: string; by: "claude" | "template" };

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

// POST /api/console/projects/:id/jobs { kind: JobKind }           -> 202 { job: Job }
//      409 if a job is already running anywhere (one at a time: one browser, one port).
//      403 with a plain reason if kind is "qa" and the host is not on CONSOLE_QA_HOSTS.
// GET  /api/console/jobs/:id                                      -> { job: Job }
// PUT  /api/console/jobs/:id/approvals { approvedProposalIds }     -> { job: Job }
// GET  /api/console/jobs/:id/draft                                -> text/plain draft spec of approved proposals only
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
//   /console/projects/:id/github     connect GitHub, workflow file, GitHub-triggered runs
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
};

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
// POST   /api/console/projects/:id/github/check            -> { github: GithubLink, startedJobId: string | null }
//        Polls now instead of waiting for the next tick (for demos).
// DELETE /api/console/projects/:id/github                  -> { github: GithubLink }
//        Forgets the token and the repo.
//
// The poller checks every watched branch every GITHUB_POLL_MS (default 60000).
// A new commit starts a Probe (kind "qa") with trigger "github", under the same
// allow-list and one-job-at-a-time rules as a manual Probe, and posts a commit
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
