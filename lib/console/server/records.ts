import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "@/lib/server/password";
import { randomBase32Secret } from "@/lib/server/totp";
import type { Job, JobKind, JobOrigin } from "../contract";

/**
 * What the console stores, and the functions that build a new record.
 *
 * The contract (lib/console/contract.ts) is what a browser may see. These are
 * the full records, including fields that must never leave the server: an
 * employee's password hash and TOTP secret, a project's encrypted QA
 * credentials, and which server process runs a job.
 *
 * Both backends store records built here, so ids, defaults and TTLs cannot
 * drift apart between the in-memory store and Supabase.
 */

/** Same lengths as the stand-in's, kept separate so the two areas can change independently. */
export const CONSOLE_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const CONSOLE_CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type EmployeeRecord = {
  id: string;
  /** Always lower case, so lookups are a plain equality. */
  email: string;
  displayName: string;
  /** scrypt "salt:hash" from lib/server/password.ts. */
  passwordHash: string;
  totpSecret: string;
  /** False until the first sign-in proves the authenticator app works. */
  totpConfirmed: boolean;
  /** Last accepted TOTP time step, so a code works once. */
  lastTotpStep: number;
  createdAt: number;
};

/**
 * An employee without the password hash and TOTP secret, for listing who has
 * access. Listing only ever needs these columns, so the secrets never leave
 * the database for it.
 */
export type EmployeeSummary = Pick<EmployeeRecord, "id" | "email" | "displayName" | "totpConfirmed" | "createdAt">;

export type ConsoleChallenge = { id: string; employeeId: string; expiresAt: number; attempts: number };

export type ConsoleSession = { id: string; employeeId: string; expiresAt: number };

export type ProjectRecord = {
  id: string;
  name: string;
  targetUrl: string;
  qaEmail: string;
  /** AES-256-GCM ciphertexts from encryption.ts, or null when not set. Never sent to a browser. */
  qaPasswordEnc: string | null;
  qaTotpSecretEnc: string | null;
  createdAt: number;
  /** Email of the employee who added it. */
  createdBy: string;
  /**
   * The Probe may save, upload and delete on this site. Off until an employee
   * turns it on for a site they own or have permission to test. This machine
   * (localhost) always has it, see qaRunRefusal in projects.ts.
   */
  fullAccess: boolean;
};

/**
 * A job as stored: the contract's Job plus the console server process that
 * owns it. After a restart that is how the console tells a job whose runner
 * died (mark it as an error) from one another live server is still running.
 */
export type JobRecord = Job & JobOrigin & { runnerHost: string; runnerPid: number };

/** Every job started from the console's own pages. Also what old rows, stored before GitHub triggers existed, read as. */
export const MANUAL_ORIGIN: JobOrigin = { trigger: "manual", commit: null };

/**
 * A workspace's GitHub connection, as stored. The contract's GithubLink is
 * what a browser sees; this adds what never leaves the server.
 *
 * The token is the employee's GitHub personal access token, AES-256-GCM encrypted with
 * encryptSecret (CONSOLE_SECRET_KEY), the same as a project's QA credentials.
 */
export type GithubLinkRecord = {
  projectId: string;
  tokenEnc: string | null;
  account: string | null;
  repo: string | null;
  branch: string | null;
  lastCheckedAt: number | null;
  lastSeenSha: string | null;
  lastTriggeredAt: number | null;
  /** GitHub's ETag for the branch head, sent back as If-None-Match so an unchanged branch costs no rate limit. */
  etag: string | null;
  /** The GitHub-started job whose final commit status has not been posted yet. */
  pendingJobId: string | null;
  /** The "Check every new commit" switch. Off: the poller leaves this workspace alone. */
  autoCheck: boolean;
};

/** The fields that can change. Only the ones passed are written. */
export type GithubLinkPatch = Partial<Omit<GithubLinkRecord, "projectId">>;

/** The fields a job may change after it is created. */
export type JobPatch = Partial<
  Pick<JobRecord, "status" | "startedAt" | "finishedAt" | "logTail" | "proposals" | "approvedProposalIds" | "result" | "error" | "explorer" | "messages" | "summary">
>;

/** A problem image of a finished Probe job, kept in the store, never on disk. n is the problem's image number. */
export type JobImage = { mime: "image/jpeg" | "image/png"; bytes: Buffer };

/** What a "Remember for this workspace" answer may change on a project. Only the fields passed are written. */
export type ProjectCredentialsPatch = Partial<Pick<ProjectRecord, "qaEmail" | "qaPasswordEnc" | "qaTotpSecretEnc">>;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Not usable until the authenticator is confirmed on first sign-in. */
export function newEmployee(input: { email: string; displayName: string; password: string }): EmployeeRecord {
  return {
    id: `emp_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    email: normalizeEmail(input.email),
    displayName: input.displayName,
    passwordHash: hashPassword(input.password),
    totpSecret: randomBase32Secret(),
    totpConfirmed: false,
    lastTotpStep: -1,
    createdAt: Date.now(),
  };
}

export function newChallenge(employeeId: string): ConsoleChallenge {
  return {
    id: randomBytes(24).toString("base64url"),
    employeeId,
    expiresAt: Date.now() + CONSOLE_CHALLENGE_TTL_MS,
    attempts: 0,
  };
}

export function newSession(employeeId: string): ConsoleSession {
  return {
    id: randomBytes(32).toString("base64url"),
    employeeId,
    expiresAt: Date.now() + CONSOLE_SESSION_TTL_MS,
  };
}

export type NewProject = Omit<ProjectRecord, "id" | "createdAt" | "fullAccess">;

/** Full access starts off, so a new workspace never changes data until someone turns it on. */
export function newProject(input: NewProject): ProjectRecord {
  return { id: `prj_${randomUUID().replace(/-/g, "").slice(0, 12)}`, ...input, createdAt: Date.now(), fullAccess: false };
}

export type NewJob = {
  projectId: string;
  kind: JobKind;
  createdBy: string;
  runnerHost: string;
  runnerPid: number;
  /** Left out by callers that predate GitHub triggers, which means manual. */
  origin?: JobOrigin;
};

/** "cjob_" so a console job id is never mistaken for one of the stand-in's "job_" ids. */
export function newJob(input: NewJob): JobRecord {
  return {
    id: `cjob_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    projectId: input.projectId,
    kind: input.kind,
    status: "queued",
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    createdBy: input.createdBy,
    logTail: "",
    proposals: null,
    approvedProposalIds: [],
    result: null,
    error: null,
    messages: [],
    summary: null,
    runnerHost: input.runnerHost,
    runnerPid: input.runnerPid,
    trigger: input.origin?.trigger ?? MANUAL_ORIGIN.trigger,
    commit: input.origin?.commit ?? MANUAL_ORIGIN.commit,
  };
}
