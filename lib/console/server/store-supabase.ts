import "server-only";
import { assertOk, client } from "@/lib/server/store-supabase";
import type { ChatMessage, Job, JobCommit, JobTrigger, Proposal } from "../contract";
import {
  newChallenge,
  newEmployee,
  newJob,
  newProject,
  newSession,
  normalizeEmail,
  MANUAL_ORIGIN,
  type ConsoleChallenge,
  type ConsoleSession,
  type EmployeeRecord,
  type EmployeeSummary,
  type GithubLinkPatch,
  type GithubLinkRecord,
  type JobImage,
  type JobPatch,
  type JobRecord,
  type NewJob,
  type NewProject,
  type ProjectCredentialsPatch,
  type ProjectRecord,
} from "./records";

/**
 * Supabase-backed console store. Tables are in db/schema-console.sql, all
 * prefixed console_. Mirrors the in-memory backend in store.ts method for
 * method: same records (built in records.ts), same sort orders, same "expired
 * counts as absent" rule.
 *
 * Uses the stand-in's single Supabase client and its error helper, so there is
 * still one client per process. It never queries an eclypse_ table.
 */

const EMPLOYEES = "console_employees";
const CHALLENGES = "console_challenges";
const SESSIONS = "console_sessions";
const PROJECTS = "console_projects";
const JOBS = "console_jobs";
const GITHUB_LINKS = "console_github_links";
const JOB_IMAGES = "console_job_images";

// ---------------------------------------------------------------------------
// Rows and mappers. Columns are snake_case, records camelCase. Timestamps are
// bigint, which supabase-js can hand back as a string, hence Number().
// ---------------------------------------------------------------------------

type EmployeeRow = {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  totp_secret: string;
  totp_confirmed: boolean;
  last_totp_step: number | string;
  created_at: number | string;
};

type ChallengeRow = { id: string; employee_id: string; expires_at: number | string; attempts: number | string };

type SessionRow = { id: string; employee_id: string; expires_at: number | string };

type ProjectRow = {
  id: string;
  name: string;
  target_url: string;
  qa_email: string;
  qa_password_enc: string | null;
  qa_totp_secret_enc: string | null;
  created_at: number | string;
  created_by: string;
  /** Missing until db/schema-console.sql has added the column, which reads as off. */
  full_access?: boolean | null;
};

type JobRow = {
  id: string;
  project_id: string;
  kind: Job["kind"];
  status: Job["status"];
  created_at: number | string;
  started_at: number | string | null;
  finished_at: number | string | null;
  created_by: string;
  log_tail: string;
  proposals: Proposal[] | null;
  approved_proposal_ids: string[];
  result: Job["result"];
  // Added later with "add column if not exists", so older rows read as empty.
  explorer?: Job["explorer"];
  messages?: ChatMessage[] | null;
  summary?: Job["summary"];
  error: string | null;
  runner_host: string;
  runner_pid: number | string;
  // Added later with "add column if not exists": rows from before read as manual with no commit.
  trigger_source?: JobTrigger | null;
  commit_info?: JobCommit | null;
};

type GithubLinkRow = {
  project_id: string;
  token_enc: string | null;
  account: string | null;
  repo: string | null;
  branch: string | null;
  last_checked_at: number | string | null;
  last_seen_sha: string | null;
  last_triggered_at: number | string | null;
  etag: string | null;
  pending_job_id: string | null;
  // Added later with "add column if not exists": missing reads as on.
  auto_check?: boolean | null;
};

const numberOrNull = (value: number | string | null) => (value === null ? null : Number(value));

function rowToEmployee(row: EmployeeRow): EmployeeRecord {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    totpSecret: row.totp_secret,
    totpConfirmed: row.totp_confirmed,
    lastTotpStep: Number(row.last_totp_step),
    createdAt: Number(row.created_at),
  };
}

function rowToChallenge(row: ChallengeRow): ConsoleChallenge {
  return { id: row.id, employeeId: row.employee_id, expiresAt: Number(row.expires_at), attempts: Number(row.attempts) };
}

function rowToSession(row: SessionRow): ConsoleSession {
  return { id: row.id, employeeId: row.employee_id, expiresAt: Number(row.expires_at) };
}

function rowToProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    targetUrl: row.target_url,
    qaEmail: row.qa_email,
    qaPasswordEnc: row.qa_password_enc,
    qaTotpSecretEnc: row.qa_totp_secret_enc,
    createdAt: Number(row.created_at),
    createdBy: row.created_by,
    fullAccess: row.full_access === true,
  };
}

function rowToJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    status: row.status,
    createdAt: Number(row.created_at),
    startedAt: numberOrNull(row.started_at),
    finishedAt: numberOrNull(row.finished_at),
    createdBy: row.created_by,
    logTail: row.log_tail,
    proposals: row.proposals,
    approvedProposalIds: row.approved_proposal_ids ?? [],
    result: row.result,
    explorer: row.explorer ?? null,
    messages: row.messages ?? [],
    summary: row.summary ?? null,
    error: row.error,
    runnerHost: row.runner_host,
    runnerPid: Number(row.runner_pid),
    trigger: row.trigger_source ?? MANUAL_ORIGIN.trigger,
    commit: row.commit_info ?? MANUAL_ORIGIN.commit,
  };
}

function rowToGithubLink(row: GithubLinkRow): GithubLinkRecord {
  return {
    projectId: row.project_id,
    tokenEnc: row.token_enc,
    account: row.account,
    repo: row.repo,
    branch: row.branch,
    lastCheckedAt: numberOrNull(row.last_checked_at),
    lastSeenSha: row.last_seen_sha,
    lastTriggeredAt: numberOrNull(row.last_triggered_at),
    etag: row.etag,
    pendingJobId: row.pending_job_id,
    autoCheck: row.auto_check !== false,
  };
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

/** Emails are stored lower case, so this is an exact match and never a LIKE pattern. */
async function findEmployeeByEmail(email: string): Promise<EmployeeRecord | undefined> {
  const { data, error } = await client().from(EMPLOYEES).select("*").eq("email", normalizeEmail(email)).maybeSingle();
  assertOk(error, "employee lookup by email");
  return data ? rowToEmployee(data as EmployeeRow) : undefined;
}

async function getEmployee(id: string): Promise<EmployeeRecord | undefined> {
  const { data, error } = await client().from(EMPLOYEES).select("*").eq("id", id).maybeSingle();
  assertOk(error, "employee lookup");
  return data ? rowToEmployee(data as EmployeeRow) : undefined;
}

async function createEmployee(input: { email: string; displayName: string; password: string }): Promise<EmployeeRecord> {
  const employee = newEmployee(input);
  const { error } = await client().from(EMPLOYEES).insert({
    id: employee.id,
    email: employee.email,
    display_name: employee.displayName,
    password_hash: employee.passwordHash,
    totp_secret: employee.totpSecret,
    totp_confirmed: employee.totpConfirmed,
    last_totp_step: employee.lastTotpStep,
    created_at: employee.createdAt,
  });
  assertOk(error, "employee insert");
  return employee;
}

async function updateEmployee(
  id: string,
  patch: Partial<Pick<EmployeeRecord, "totpConfirmed" | "lastTotpStep">>,
): Promise<void> {
  // Only the fields actually passed are written.
  const row: Record<string, unknown> = {};
  if (patch.totpConfirmed !== undefined) row.totp_confirmed = patch.totpConfirmed;
  if (patch.lastTotpStep !== undefined) row.last_totp_step = patch.lastTotpStep;
  if (Object.keys(row).length === 0) return;
  const { error } = await client().from(EMPLOYEES).update(row).eq("id", id);
  assertOk(error, "employee update");
}

/**
 * Oldest first, so the first employee added heads the list. Selects only the
 * columns a list shows: the password hash and TOTP secret are never fetched.
 */
async function listEmployees(): Promise<EmployeeSummary[]> {
  const { data, error } = await client().from(EMPLOYEES).select("id, email, display_name, totp_confirmed, created_at");
  assertOk(error, "employee list");
  type SummaryRow = Pick<EmployeeRow, "id" | "email" | "display_name" | "totp_confirmed" | "created_at">;
  return ((data ?? []) as SummaryRow[])
    .map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      totpConfirmed: row.totp_confirmed,
      createdAt: Number(row.created_at),
    }))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Removes an employee so their access ends now, not when a session expires.
 *
 * Sessions go first, then pending sign-in challenges, then the employee. If a
 * step fails partway, the employee is already signed out everywhere, which is
 * the safe way to fail. The sessions are deleted explicitly rather than left
 * to the "on delete cascade" in db/schema-console.sql, so the count is real
 * and the code says what it does. The cascade stays as the safety net for a
 * session created between the first delete and the last.
 */
async function deleteEmployee(id: string): Promise<{ sessionsEnded: number }> {
  const { count, error } = await client().from(SESSIONS).delete({ count: "exact" }).eq("employee_id", id);
  assertOk(error, "session delete for employee");
  const { error: challengeError } = await client().from(CHALLENGES).delete().eq("employee_id", id);
  assertOk(challengeError, "challenge delete for employee");
  const { error: employeeError } = await client().from(EMPLOYEES).delete().eq("id", id);
  assertOk(employeeError, "employee delete");
  return { sessionsEnded: count ?? 0 };
}

// ---------------------------------------------------------------------------
// Challenges and sessions
// ---------------------------------------------------------------------------

async function createChallenge(employeeId: string): Promise<ConsoleChallenge> {
  const challenge = newChallenge(employeeId);
  const { error } = await client().from(CHALLENGES).insert({
    id: challenge.id,
    employee_id: challenge.employeeId,
    expires_at: challenge.expiresAt,
    attempts: challenge.attempts,
  });
  assertOk(error, "challenge insert");
  return challenge;
}

async function getChallenge(id: string): Promise<ConsoleChallenge | undefined> {
  const { data, error } = await client().from(CHALLENGES).select("*").eq("id", id).maybeSingle();
  assertOk(error, "challenge lookup");
  if (!data) return undefined;
  const challenge = rowToChallenge(data as ChallengeRow);
  return challenge.expiresAt < Date.now() ? undefined : challenge;
}

/** A read then a write, as in the stand-in's adapter. Not atomic, and neither is the in-memory attempts++. */
async function bumpChallengeAttempts(id: string): Promise<void> {
  const { data, error } = await client().from(CHALLENGES).select("attempts").eq("id", id).maybeSingle();
  assertOk(error, "challenge attempt read");
  if (!data) return;
  const attempts = Number((data as { attempts: number | string }).attempts) + 1;
  const { error: updateError } = await client().from(CHALLENGES).update({ attempts }).eq("id", id);
  assertOk(updateError, "challenge attempt update");
}

async function deleteChallenge(id: string): Promise<void> {
  const { error } = await client().from(CHALLENGES).delete().eq("id", id);
  assertOk(error, "challenge delete");
}

async function createSession(employeeId: string): Promise<ConsoleSession> {
  const session = newSession(employeeId);
  const { error } = await client().from(SESSIONS).insert({
    id: session.id,
    employee_id: session.employeeId,
    expires_at: session.expiresAt,
  });
  assertOk(error, "session insert");
  return session;
}

async function resolveSession(
  sessionId: string | undefined,
): Promise<{ session: ConsoleSession; employee: EmployeeRecord } | null> {
  if (!sessionId) return null;
  const { data, error } = await client().from(SESSIONS).select("*").eq("id", sessionId).maybeSingle();
  assertOk(error, "session lookup");
  if (!data) return null;
  const session = rowToSession(data as SessionRow);
  if (session.expiresAt < Date.now()) return null;
  const employee = await getEmployee(session.employeeId);
  return employee ? { session, employee } : null;
}

async function deleteSession(sessionId: string): Promise<void> {
  const { error } = await client().from(SESSIONS).delete().eq("id", sessionId);
  assertOk(error, "session delete");
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** Sorted in JavaScript, newest first, with the same comparator as the in-memory backend. */
async function listProjects(): Promise<ProjectRecord[]> {
  const { data, error } = await client().from(PROJECTS).select("*");
  assertOk(error, "project list");
  return ((data ?? []) as ProjectRow[]).map(rowToProject).sort((a, b) => b.createdAt - a.createdAt);
}

async function getProject(id: string): Promise<ProjectRecord | undefined> {
  const { data, error } = await client().from(PROJECTS).select("*").eq("id", id).maybeSingle();
  assertOk(error, "project lookup");
  return data ? rowToProject(data as ProjectRow) : undefined;
}

async function createProject(input: NewProject): Promise<ProjectRecord> {
  const project = newProject(input);
  const { error } = await client().from(PROJECTS).insert({
    id: project.id,
    name: project.name,
    target_url: project.targetUrl,
    qa_email: project.qaEmail,
    qa_password_enc: project.qaPasswordEnc,
    qa_totp_secret_enc: project.qaTotpSecretEnc,
    created_at: project.createdAt,
    created_by: project.createdBy,
  });
  assertOk(error, "project insert");
  return project;
}

/** Only the fields passed are written, so saving a remembered login leaves the authenticator key alone. */
async function updateProjectCredentials(id: string, patch: ProjectCredentialsPatch): Promise<void> {
  const row: Record<string, unknown> = {};
  if (patch.qaEmail !== undefined) row.qa_email = patch.qaEmail;
  if (patch.qaPasswordEnc !== undefined) row.qa_password_enc = patch.qaPasswordEnc;
  if (patch.qaTotpSecretEnc !== undefined) row.qa_totp_secret_enc = patch.qaTotpSecretEnc;
  if (Object.keys(row).length === 0) return;
  const { error } = await client().from(PROJECTS).update(row).eq("id", id);
  assertOk(error, "project credentials update");
}

async function setProjectFullAccess(id: string, fullAccess: boolean): Promise<void> {
  const { error } = await client().from(PROJECTS).update({ full_access: fullAccess }).eq("id", id);
  // The likely cause is the column not being there yet. Saying so beats a bare Postgres error.
  if (error) throw new Error(`Could not save Full access (${error.message}). Run db/schema-console.sql in the Supabase SQL editor to add the column.`);
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

async function createJob(input: NewJob): Promise<JobRecord> {
  const job = newJob(input);
  const { error } = await client().from(JOBS).insert({
    id: job.id,
    project_id: job.projectId,
    kind: job.kind,
    status: job.status,
    created_at: job.createdAt,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
    created_by: job.createdBy,
    log_tail: job.logTail,
    proposals: job.proposals,
    approved_proposal_ids: job.approvedProposalIds,
    result: job.result,
    error: job.error,
    // messages is left to its column default, so creating a job still works
    // on a database that has not had the column added yet.
    runner_host: job.runnerHost,
    runner_pid: job.runnerPid,
    trigger_source: job.trigger,
    commit_info: job.commit,
  });
  assertOk(error, "job insert");
  return job;
}

async function getJob(id: string): Promise<JobRecord | undefined> {
  const { data, error } = await client().from(JOBS).select("*").eq("id", id).maybeSingle();
  assertOk(error, "job lookup");
  return data ? rowToJob(data as JobRow) : undefined;
}

async function listJobs(projectId: string): Promise<JobRecord[]> {
  const { data, error } = await client().from(JOBS).select("*").eq("project_id", projectId);
  assertOk(error, "job list");
  return ((data ?? []) as JobRow[]).map(rowToJob).sort((a, b) => b.createdAt - a.createdAt);
}

async function lastJob(projectId: string): Promise<JobRecord | undefined> {
  const { data, error } = await client()
    .from(JOBS)
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1);
  assertOk(error, "last job lookup");
  const rows = (data ?? []) as JobRow[];
  return rows.length > 0 ? rowToJob(rows[0]) : undefined;
}

async function listUnfinishedJobs(): Promise<JobRecord[]> {
  const { data, error } = await client().from(JOBS).select("*").in("status", ["queued", "running", "waiting"]);
  assertOk(error, "unfinished job list");
  return ((data ?? []) as JobRow[]).map(rowToJob);
}

/** Only the fields actually passed are written, so a log flush cannot clear a result. */
async function updateJob(id: string, patch: JobPatch): Promise<void> {
  const row: Record<string, unknown> = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.startedAt !== undefined) row.started_at = patch.startedAt;
  if (patch.finishedAt !== undefined) row.finished_at = patch.finishedAt;
  if (patch.logTail !== undefined) row.log_tail = patch.logTail;
  if (patch.proposals !== undefined) row.proposals = patch.proposals;
  if (patch.approvedProposalIds !== undefined) row.approved_proposal_ids = patch.approvedProposalIds;
  if (patch.result !== undefined) row.result = patch.result;
  if (patch.error !== undefined) row.error = patch.error;
  // These columns come from the "add column if not exists" lines in db/schema-console.sql.
  if (patch.explorer !== undefined) row.explorer = patch.explorer;
  if (patch.messages !== undefined) row.messages = patch.messages;
  if (patch.summary !== undefined) row.summary = patch.summary;
  if (Object.keys(row).length === 0) return;
  const { error } = await client().from(JOBS).update(row).eq("id", id);
  assertOk(error, "job update");
}

// ---------------------------------------------------------------------------
// GitHub links, one row per workspace
// ---------------------------------------------------------------------------

async function getGithubLink(projectId: string): Promise<GithubLinkRecord | undefined> {
  const { data, error } = await client().from(GITHUB_LINKS).select("*").eq("project_id", projectId).maybeSingle();
  assertOk(error, "github link lookup");
  return data ? rowToGithubLink(data as GithubLinkRow) : undefined;
}

async function listGithubLinks(): Promise<GithubLinkRecord[]> {
  const { data, error } = await client().from(GITHUB_LINKS).select("*");
  assertOk(error, "github link list");
  return ((data ?? []) as GithubLinkRow[]).map(rowToGithubLink);
}

/**
 * An upsert on the project id with only the columns passed, so the row is
 * created on first use and a poller write cannot wipe a field it did not touch.
 */
async function patchGithubLink(projectId: string, patch: GithubLinkPatch): Promise<GithubLinkRecord> {
  const row: Record<string, unknown> = { project_id: projectId };
  if (patch.tokenEnc !== undefined) row.token_enc = patch.tokenEnc;
  if (patch.account !== undefined) row.account = patch.account;
  if (patch.repo !== undefined) row.repo = patch.repo;
  if (patch.branch !== undefined) row.branch = patch.branch;
  if (patch.lastCheckedAt !== undefined) row.last_checked_at = patch.lastCheckedAt;
  if (patch.lastSeenSha !== undefined) row.last_seen_sha = patch.lastSeenSha;
  if (patch.lastTriggeredAt !== undefined) row.last_triggered_at = patch.lastTriggeredAt;
  if (patch.etag !== undefined) row.etag = patch.etag;
  if (patch.pendingJobId !== undefined) row.pending_job_id = patch.pendingJobId;
  // Only written when the switch changes, so every other write works before the column exists.
  if (patch.autoCheck !== undefined) row.auto_check = patch.autoCheck;
  const { data, error } = await client()
    .from(GITHUB_LINKS)
    .upsert(row, { onConflict: "project_id" })
    .select("*")
    .single();
  if (error && patch.autoCheck !== undefined) {
    // The likely cause is the column not being there yet. Saying so beats a bare Postgres error.
    throw new Error(`Could not save the switch (${error.message}). Run db/schema-console.sql in the Supabase SQL editor to add the column.`);
  }
  assertOk(error, "github link upsert");
  return rowToGithubLink(data as GithubLinkRow);
}

async function deleteGithubLink(projectId: string): Promise<void> {
  const { error } = await client().from(GITHUB_LINKS).delete().eq("project_id", projectId);
  assertOk(error, "github link delete");
}

// ---------------------------------------------------------------------------
// Job images
// ---------------------------------------------------------------------------

/** Throws when the table is missing; the runner catches it and says what to run. */
async function saveJobImage(jobId: string, n: number, image: JobImage): Promise<void> {
  const { error } = await client()
    .from(JOB_IMAGES)
    .upsert({ job_id: jobId, n, mime: image.mime, data: image.bytes.toString("base64"), created_at: Date.now() }, { onConflict: "job_id,n" });
  assertOk(error, "job image save");
}

/** Null when there is no such image, or the table has not been added yet. */
async function getJobImage(jobId: string, n: number): Promise<JobImage | null> {
  const { data, error } = await client().from(JOB_IMAGES).select("mime, data").eq("job_id", jobId).eq("n", n).maybeSingle();
  if (error || !data) return null;
  const row = data as { mime: string; data: string };
  if (row.mime !== "image/jpeg" && row.mime !== "image/png") return null;
  return { mime: row.mime, bytes: Buffer.from(row.data, "base64") };
}

// ---------------------------------------------------------------------------

export const supabaseConsoleBackend = {
  findEmployeeByEmail,
  getEmployee,
  createEmployee,
  updateEmployee,
  listEmployees,
  deleteEmployee,
  createChallenge,
  getChallenge,
  bumpChallengeAttempts,
  deleteChallenge,
  createSession,
  resolveSession,
  deleteSession,
  listProjects,
  getProject,
  createProject,
  updateProjectCredentials,
  setProjectFullAccess,
  createJob,
  getJob,
  listJobs,
  lastJob,
  listUnfinishedJobs,
  updateJob,
  getGithubLink,
  listGithubLinks,
  patchGithubLink,
  deleteGithubLink,
  saveJobImage,
  getJobImage,
};
