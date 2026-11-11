import "server-only";
import { isSupabaseEnabled } from "@/lib/server/auth-store";
import {
  newChallenge,
  newEmployee,
  newJob,
  newProject,
  newSession,
  normalizeEmail,
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
import { normalizeTotpSecret } from "./projects";
import { supabaseConsoleBackend } from "./store-supabase";

/**
 * Console storage over either backend: employees, their sign-in challenges and
 * sessions, projects and jobs. The console's twin of lib/server/auth-store.ts.
 *
 * Nothing here reads or writes the stand-in's users, sessions or tenants. The
 * console has its own Maps in memory and its own console_* tables in
 * Postgres, and the only thing borrowed from the stand-in is the switch that
 * decides which backend is live (isSupabaseEnabled), so the two areas can
 * never disagree about it.
 *
 * Unlike the stand-in, the console's data is meant to persist on Supabase:
 * employees, projects and job history are not wiped between QA runs.
 */

export type ResolvedConsoleSession = { session: ConsoleSession; employee: EmployeeRecord };

export type ConsoleBackend = {
  findEmployeeByEmail(email: string): Promise<EmployeeRecord | undefined>;
  getEmployee(id: string): Promise<EmployeeRecord | undefined>;
  createEmployee(input: { email: string; displayName: string; password: string }): Promise<EmployeeRecord>;
  updateEmployee(id: string, patch: Partial<Pick<EmployeeRecord, "totpConfirmed" | "lastTotpStep">>): Promise<void>;
  /** Oldest first. Only for `npm run admin` (scripts/admin.ts). */
  listEmployees(): Promise<EmployeeSummary[]>;
  /**
   * Removes the employee and ends every session they have, so their access
   * stops at once. Says how many sessions were ended. Only for `npm run admin`.
   */
  deleteEmployee(id: string): Promise<{ sessionsEnded: number }>;
  createChallenge(employeeId: string): Promise<ConsoleChallenge>;
  getChallenge(id: string): Promise<ConsoleChallenge | undefined>;
  bumpChallengeAttempts(id: string): Promise<void>;
  deleteChallenge(id: string): Promise<void>;
  createSession(employeeId: string): Promise<ConsoleSession>;
  resolveSession(sessionId: string | undefined): Promise<ResolvedConsoleSession | null>;
  deleteSession(sessionId: string): Promise<void>;
  listProjects(): Promise<ProjectRecord[]>;
  getProject(id: string): Promise<ProjectRecord | undefined>;
  createProject(input: NewProject): Promise<ProjectRecord>;
  /** Saves a QA login or authenticator key an employee gave in a job's chat with "Remember for this workspace". */
  updateProjectCredentials(id: string, patch: ProjectCredentialsPatch): Promise<void>;
  /** The workspace's "Full access" switch on the Probe tab. */
  setProjectFullAccess(id: string, fullAccess: boolean): Promise<void>;
  createJob(input: NewJob): Promise<JobRecord>;
  getJob(id: string): Promise<JobRecord | undefined>;
  /** Newest first. */
  listJobs(projectId: string): Promise<JobRecord[]>;
  lastJob(projectId: string): Promise<JobRecord | undefined>;
  /** Jobs still queued, running or waiting for an answer, on any project. */
  listUnfinishedJobs(): Promise<JobRecord[]>;
  updateJob(id: string, patch: JobPatch): Promise<void>;
  /** The workspace's GitHub connection, or undefined if it was never connected. */
  getGithubLink(projectId: string): Promise<GithubLinkRecord | undefined>;
  /** Every stored connection, for the poller. */
  listGithubLinks(): Promise<GithubLinkRecord[]>;
  /** Creates the row if needed and writes only the fields passed. */
  patchGithubLink(projectId: string, patch: GithubLinkPatch): Promise<GithubLinkRecord>;
  /** Forgets the token and the repo. */
  deleteGithubLink(projectId: string): Promise<void>;
  /** Stores problem image n of a job, replacing one with the same number. */
  saveJobImage(jobId: string, n: number, image: JobImage): Promise<void>;
  /** Problem image n of a job, or null when it was not saved. */
  getJobImage(jobId: string, n: number): Promise<JobImage | null>;
};

// ---------------------------------------------------------------------------
// In-memory backend
// ---------------------------------------------------------------------------

type ConsoleDb = {
  employees: Map<string, EmployeeRecord>;
  challenges: Map<string, ConsoleChallenge>;
  sessions: Map<string, ConsoleSession>;
  projects: Map<string, ProjectRecord>;
  jobs: Map<string, JobRecord>;
  /** Keyed by project id: one GitHub connection per workspace. */
  githubLinks: Map<string, GithubLinkRecord>;
  /** Keyed by "<job id>:<n>". Optional because a store kept across a hot reload predates it. */
  jobImages?: Map<string, JobImage>;
};

/**
 * Employees are provisioned, never self-registered. On this backend the only
 * way in is the employee named by SEED_CONSOLE_EMAIL and SEED_CONSOLE_PASSWORD,
 * created unconfirmed so the first sign-in walks them through authenticator
 * setup. With neither set there is no employee and nobody can sign in.
 *
 * SEED_CONSOLE_TOTP_SECRET is optional, for local use with a real phone. This
 * store starts empty on every restart, so without it the employee gets a new
 * secret each time and the authenticator app collects stale entries. With it,
 * the employee is seeded with that secret, already confirmed, and the same
 * authenticator entry keeps working. The value is never logged. One that is
 * not valid base32 fails loudly, with an error naming the variable and not the
 * value, rather than quietly falling back to a fresh secret.
 */
function seed(): ConsoleDb {
  const db: ConsoleDb = {
    employees: new Map(),
    challenges: new Map(),
    sessions: new Map(),
    projects: new Map(),
    jobs: new Map(),
    githubLinks: new Map(),
    jobImages: new Map(),
  };
  const email = process.env.SEED_CONSOLE_EMAIL?.trim();
  const password = process.env.SEED_CONSOLE_PASSWORD;
  if (email && password) {
    const employee = newEmployee({ email, displayName: email.split("@")[0], password });
    const fixedSecret = process.env.SEED_CONSOLE_TOTP_SECRET?.trim();
    if (fixedSecret) {
      const secret = normalizeTotpSecret(fixedSecret);
      if (!secret) throw new Error("SEED_CONSOLE_TOTP_SECRET is set but is not a valid base32 TOTP secret.");
      employee.totpSecret = secret;
      employee.totpConfirmed = true;
    }
    db.employees.set(employee.id, employee);
  }
  return db;
}

/**
 * Built on first use, not at import, so the Supabase backend never seeds a
 * memory store it does not use. Kept on globalThis like the stand-in's store,
 * so a hot reload in development does not wipe it.
 */
const globalForConsole = globalThis as unknown as { __eclypseConsoleDb?: ConsoleDb };
const mem = (): ConsoleDb => (globalForConsole.__eclypseConsoleDb ??= seed());

/**
 * Every record goes in and comes out as a copy. That makes this backend
 * behave like Postgres: a route that changes a record it was handed, instead
 * of calling an update method, changes nothing here either, so the mistake
 * shows up on the default backend and not only in production. See "What broke
 * when moving from memory to Postgres?" in docs/KNOWLEDGE.md.
 */
const copy = <T>(value: T): T => structuredClone(value);

const jobImages = (): Map<string, JobImage> => (mem().jobImages ??= new Map());
const copyImage = (image: JobImage): JobImage => ({ mime: image.mime, bytes: Buffer.from(image.bytes) });

function emptyGithubLink(projectId: string): GithubLinkRecord {
  return {
    projectId,
    tokenEnc: null,
    account: null,
    repo: null,
    branch: null,
    lastCheckedAt: null,
    lastSeenSha: null,
    lastTriggeredAt: null,
    etag: null,
    pendingJobId: null,
    autoCheck: true,
  };
}

const memoryBackend: ConsoleBackend = {
  async findEmployeeByEmail(email) {
    const needle = normalizeEmail(email);
    const found = [...mem().employees.values()].find((e) => e.email === needle);
    return found && copy(found);
  },
  async getEmployee(id) {
    const found = mem().employees.get(id);
    return found && copy(found);
  },
  async createEmployee(input) {
    const employee = newEmployee(input);
    mem().employees.set(employee.id, copy(employee));
    return employee;
  },
  async updateEmployee(id, patch) {
    const employee = mem().employees.get(id);
    if (employee) Object.assign(employee, patch);
  },
  // Used by the /admin portal, which runs inside this process. `npm run admin`
  // is a separate process and cannot reach this store, so it is Supabase only.
  async listEmployees() {
    return [...mem().employees.values()]
      .map(({ id, email, displayName, totpConfirmed, createdAt }) => ({ id, email, displayName, totpConfirmed, createdAt }))
      .sort((a, b) => a.createdAt - b.createdAt);
  },
  async deleteEmployee(id) {
    const db = mem();
    let sessionsEnded = 0;
    for (const [key, session] of db.sessions) {
      if (session.employeeId === id) {
        db.sessions.delete(key);
        sessionsEnded++;
      }
    }
    for (const [key, challenge] of db.challenges) if (challenge.employeeId === id) db.challenges.delete(key);
    db.employees.delete(id);
    return { sessionsEnded };
  },
  async createChallenge(employeeId) {
    const challenge = newChallenge(employeeId);
    mem().challenges.set(challenge.id, copy(challenge));
    return challenge;
  },
  async getChallenge(id) {
    const challenge = mem().challenges.get(id);
    // Expired counts as absent, as in the stand-in.
    return challenge && challenge.expiresAt >= Date.now() ? copy(challenge) : undefined;
  },
  async bumpChallengeAttempts(id) {
    const challenge = mem().challenges.get(id);
    if (challenge) challenge.attempts++;
  },
  async deleteChallenge(id) {
    mem().challenges.delete(id);
  },
  async createSession(employeeId) {
    const session = newSession(employeeId);
    mem().sessions.set(session.id, copy(session));
    return session;
  },
  async resolveSession(sessionId) {
    if (!sessionId) return null;
    const session = mem().sessions.get(sessionId);
    if (!session || session.expiresAt < Date.now()) return null;
    const employee = mem().employees.get(session.employeeId);
    if (!employee) return null;
    return { session: copy(session), employee: copy(employee) };
  },
  async deleteSession(sessionId) {
    mem().sessions.delete(sessionId);
  },
  async listProjects() {
    return [...mem().projects.values()].map(copy).sort((a, b) => b.createdAt - a.createdAt);
  },
  async getProject(id) {
    const project = mem().projects.get(id);
    return project && copy(project);
  },
  async createProject(input) {
    const project = newProject(input);
    mem().projects.set(project.id, copy(project));
    return project;
  },
  async updateProjectCredentials(id, patch) {
    const project = mem().projects.get(id);
    if (project) Object.assign(project, copy(patch));
  },
  async setProjectFullAccess(id, fullAccess) {
    const project = mem().projects.get(id);
    if (project) project.fullAccess = fullAccess;
  },
  async createJob(input) {
    const job = newJob(input);
    mem().jobs.set(job.id, copy(job));
    return job;
  },
  async getJob(id) {
    const job = mem().jobs.get(id);
    return job && copy(job);
  },
  async listJobs(projectId) {
    return [...mem().jobs.values()]
      .filter((j) => j.projectId === projectId)
      .map(copy)
      .sort((a, b) => b.createdAt - a.createdAt);
  },
  async lastJob(projectId) {
    return (await memoryBackend.listJobs(projectId))[0];
  },
  async listUnfinishedJobs() {
    return [...mem().jobs.values()].filter((j) => j.status === "queued" || j.status === "running" || j.status === "waiting").map(copy);
  },
  async updateJob(id, patch) {
    const job = mem().jobs.get(id);
    if (job) Object.assign(job, copy(patch));
  },
  async getGithubLink(projectId) {
    const link = mem().githubLinks.get(projectId);
    return link && copy(link);
  },
  async listGithubLinks() {
    return [...mem().githubLinks.values()].map(copy);
  },
  async patchGithubLink(projectId, patch) {
    const link = mem().githubLinks.get(projectId) ?? emptyGithubLink(projectId);
    Object.assign(link, copy(patch));
    mem().githubLinks.set(projectId, link);
    return copy(link);
  },
  async deleteGithubLink(projectId) {
    mem().githubLinks.delete(projectId);
  },
  async saveJobImage(jobId, n, image) {
    jobImages().set(`${jobId}:${n}`, copyImage(image));
  },
  async getJobImage(jobId, n) {
    const image = jobImages().get(`${jobId}:${n}`);
    return image ? copyImage(image) : null;
  },
};

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

const backend: ConsoleBackend = isSupabaseEnabled() ? supabaseConsoleBackend : memoryBackend;

// listEmployees and deleteEmployee are only for managing employees: the /admin
// portal (app/api/admin, behind lib/admin/auth.ts) and `npm run admin`. No
// console route may use them.
export const listEmployees: ConsoleBackend["listEmployees"] = () => backend.listEmployees();
export const deleteEmployee: ConsoleBackend["deleteEmployee"] = (id) => backend.deleteEmployee(id);
export const findEmployeeByEmail: ConsoleBackend["findEmployeeByEmail"] = (e) => backend.findEmployeeByEmail(e);
export const getEmployee: ConsoleBackend["getEmployee"] = (id) => backend.getEmployee(id);
export const createEmployee: ConsoleBackend["createEmployee"] = (i) => backend.createEmployee(i);
export const updateEmployee: ConsoleBackend["updateEmployee"] = (id, p) => backend.updateEmployee(id, p);
export const createChallenge: ConsoleBackend["createChallenge"] = (e) => backend.createChallenge(e);
export const getChallenge: ConsoleBackend["getChallenge"] = (id) => backend.getChallenge(id);
export const bumpChallengeAttempts: ConsoleBackend["bumpChallengeAttempts"] = (id) => backend.bumpChallengeAttempts(id);
export const deleteChallenge: ConsoleBackend["deleteChallenge"] = (id) => backend.deleteChallenge(id);
export const createSession: ConsoleBackend["createSession"] = (e) => backend.createSession(e);
export const resolveSession: ConsoleBackend["resolveSession"] = (s) => backend.resolveSession(s);
export const deleteSession: ConsoleBackend["deleteSession"] = (s) => backend.deleteSession(s);
export const listProjects: ConsoleBackend["listProjects"] = () => backend.listProjects();
export const getProject: ConsoleBackend["getProject"] = (id) => backend.getProject(id);
export const createProject: ConsoleBackend["createProject"] = (i) => backend.createProject(i);
export const updateProjectCredentials: ConsoleBackend["updateProjectCredentials"] = (id, p) =>
  backend.updateProjectCredentials(id, p);
export const setProjectFullAccess: ConsoleBackend["setProjectFullAccess"] = (id, on) => backend.setProjectFullAccess(id, on);
export const createJob: ConsoleBackend["createJob"] = (i) => backend.createJob(i);
export const getJob: ConsoleBackend["getJob"] = (id) => backend.getJob(id);
export const listJobs: ConsoleBackend["listJobs"] = (p) => backend.listJobs(p);
export const lastJob: ConsoleBackend["lastJob"] = (p) => backend.lastJob(p);
export const listUnfinishedJobs: ConsoleBackend["listUnfinishedJobs"] = () => backend.listUnfinishedJobs();
export const updateJob: ConsoleBackend["updateJob"] = (id, p) => backend.updateJob(id, p);
export const getGithubLink: ConsoleBackend["getGithubLink"] = (p) => backend.getGithubLink(p);
export const listGithubLinks: ConsoleBackend["listGithubLinks"] = () => backend.listGithubLinks();
export const patchGithubLink: ConsoleBackend["patchGithubLink"] = (p, x) => backend.patchGithubLink(p, x);
export const deleteGithubLink: ConsoleBackend["deleteGithubLink"] = (p) => backend.deleteGithubLink(p);
export const saveJobImage: ConsoleBackend["saveJobImage"] = (j, n, i) => backend.saveJobImage(j, n, i);
export const getJobImage: ConsoleBackend["getJobImage"] = (j, n) => backend.getJobImage(j, n);
