import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { analyse, AiJobError } from "./ai";
import type { Report } from "./analysis";
import { bug } from "./bugs";
import type { CsvTable } from "./csv";
import { checkPassword, hashPassword } from "./password";
import { randomBase32Secret } from "./totp";

export { checkPassword, hashPassword };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Tenant = { id: string; slug: string; name: string };

export type Role = "admin" | "viewer";

export type User = {
  id: string;
  email: string;
  passwordHash: string;
  totpSecret: string;
  /** False until the user proves their authenticator app works (sign-up step 2). */
  totpConfirmed: boolean;
  /** Last accepted TOTP time step: a code can only be used once. */
  lastTotpStep: number;
  displayName: string;
  notificationEmail: string;
};

/** A user's place in an organization. One user can be in several. */
export type Membership = { userId: string; tenantId: string; role: Role };

/** A pending invitation to join an organization. No email is sent in the stand-in. */
export type Invite = { id: string; tenantId: string; email: string; role: Role; invitedAt: number; invitedBy: string };

/** tenantId stays null until the user picks an organization after sign-in. */
export type Session = { id: string; userId: string; tenantId: string | null; expiresAt: number };

export type Challenge = {
  id: string;
  userId: string;
  expiresAt: number;
  attempts: number;
};

export type DocumentRecord = {
  id: string;
  tenantId: string;
  name: string;
  sizeBytes: number;
  table: CsvTable;
  uploadedAt: number;
  uploadedBy: string;
};

export type JobRecord = {
  id: string;
  tenantId: string;
  documentId: string;
  documentName: string;
  createdAt: number;
  analysisDoneAt: number | null;
  report: Report | null;
  error: string | null;
};

type Db = {
  tenants: Map<string, Tenant>;
  users: Map<string, User>;
  memberships: Membership[];
  invites: Map<string, Invite>;
  sessions: Map<string, Session>;
  challenges: Map<string, Challenge>;
  documents: Map<string, DocumentRecord>;
  jobs: Map<string, JobRecord>;
};

// ---------------------------------------------------------------------------
// Seed data. Everything here is fictional.
// ---------------------------------------------------------------------------

export const QA_TENANT_SLUG = "qa-synthetic";
export const CANARY_DOC_ID = "doc_qacanary_0001";

function table(rows: string[][]): CsvTable {
  return { header: ["subject_id", "arm", "age", "adverse_event", "severity"], rows };
}

function seed(): Db {
  const db: Db = {
    tenants: new Map(),
    users: new Map(),
    memberships: [],
    invites: new Map(),
    sessions: new Map(),
    challenges: new Map(),
    documents: new Map(),
    jobs: new Map(),
  };

  const tenants: Tenant[] = [
    { id: "t_acme", slug: "acme-pharma", name: "Acme Pharma" },
    { id: "t_northwind", slug: "northwind-health", name: "Northwind Health" },
    { id: "t_qa", slug: QA_TENANT_SLUG, name: "QA Synthetic" },
    { id: "t_qa_canary", slug: "qa-canary", name: "QA Canary" },
  ];
  for (const t of tenants) db.tenants.set(t.id, t);

  // Client users exist so their data exists; their credentials are random and
  // never leave the process. The QA bot has no way to sign in as them.
  const addUser = (tenantId: string, email: string, password: string, totpSecret: string, role: Role = "admin") => {
    const u: User = {
      id: `u_${randomUUID().slice(0, 8)}`,
      email,
      passwordHash: hashPassword(password),
      totpSecret,
      totpConfirmed: true,
      lastTotpStep: -1,
      displayName: email.split("@")[0],
      notificationEmail: email,
    };
    db.users.set(u.id, u);
    db.memberships.push({ userId: u.id, tenantId, role });
    return u;
  };

  const acmeUser = addUser("t_acme", "j.doe@acme-pharma.example", randomUUID(), randomBase32Secret());
  const nwUser = addUser("t_northwind", "r.lee@northwind-health.example", randomUUID(), randomBase32Secret());
  const canaryUser = addUser("t_qa_canary", "qa-canary@synthetic.eclypse.test", randomUUID(), randomBase32Secret());

  // The QA bot is only created when its credentials are supplied through the
  // environment (from a secret store in CI). No default credentials exist.
  const qaPassword = process.env.SEED_QA_PASSWORD;
  const qaTotp = process.env.SEED_QA_TOTP_SECRET;
  if (qaPassword && qaTotp) {
    const qa = addUser("t_qa", process.env.SEED_QA_EMAIL ?? "qa-bot@synthetic.eclypse.test", qaPassword, qaTotp);
    qa.displayName = "QA Bot";
  }
  // Second QA account, a read-only Viewer in the same QA org, to test roles.
  const viewerPassword = process.env.SEED_QA_VIEWER_PASSWORD;
  const viewerTotp = process.env.SEED_QA_VIEWER_TOTP_SECRET;
  if (viewerPassword && viewerTotp) {
    const email = process.env.SEED_QA_VIEWER_EMAIL ?? "qa-viewer@synthetic.eclypse.test";
    const viewer = addUser("t_qa", email, viewerPassword, viewerTotp, "viewer");
    viewer.displayName = "QA Viewer";
  }

  const addDoc = (id: string, tenantId: string, name: string, uploadedBy: string, rows: string[][]) => {
    db.documents.set(id, {
      id,
      tenantId,
      name,
      sizeBytes: rows.length * 40,
      table: table(rows),
      uploadedAt: Date.UTC(2026, 9, 1, 9, 0, 0),
      uploadedBy,
    });
  };

  addDoc("doc_acme_0001", "t_acme", "PH2-ONC-114 interim AE listing.csv", acmeUser.id, [
    ["ONC-001", "treatment", "61", "neutropenia", "severe"],
    ["ONC-002", "placebo", "58", "fatigue", "mild"],
  ]);
  addDoc("doc_nw_0001", "t_northwind", "NW-CARD-07 safety listing.csv", nwUser.id, [
    ["CARD-01", "treatment", "70", "dizziness", "moderate"],
  ]);
  // Canary: lives in a second synthetic tenant that the QA team owns. If the
  // QA bot can ever see this marker, tenant isolation is broken.
  addDoc(CANARY_DOC_ID, "t_qa_canary", "QA-CANARY-7f3a2c do-not-display.csv", canaryUser.id, [
    ["QA-CANARY-7f3a2c", "placebo", "40", "canary", "mild"],
  ]);

  return db;
}

const globalForDb = globalThis as unknown as { __eclypseDb?: Db };
export const db: Db = (globalForDb.__eclypseDb ??= seed());

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export function findUserByEmail(email: string): User | undefined {
  const needle = email.trim().toLowerCase();
  return [...db.users.values()].find((u) => u.email.toLowerCase() === needle);
}

export function createChallenge(userId: string): Challenge {
  const c: Challenge = {
    id: randomBytes(24).toString("base64url"),
    userId,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
    attempts: 0,
  };
  db.challenges.set(c.id, c);
  return c;
}

export function createSession(userId: string): Session {
  const s: Session = {
    id: randomBytes(32).toString("base64url"),
    userId,
    tenantId: null,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  db.sessions.set(s.id, s);
  return s;
}

/**
 * The signed-in user, plus the organization they picked (null until they
 * pick one). Membership is re-checked on every request, so removing someone
 * from an organization takes effect immediately.
 */
export function resolveSession(sessionId: string | undefined) {
  if (!sessionId) return null;
  const s = db.sessions.get(sessionId);
  if (!s || s.expiresAt < Date.now()) return null;
  const user = db.users.get(s.userId);
  if (!user) return null;
  const membership = s.tenantId ? findMembership(user.id, s.tenantId) : undefined;
  const tenant = membership ? db.tenants.get(membership.tenantId)! : null;
  return { session: s, user, tenant, role: membership?.role ?? null };
}

// ---------------------------------------------------------------------------
// Accounts and organizations
// ---------------------------------------------------------------------------

/** New account from the sign-up form. Not usable until the authenticator is confirmed. */
export function createUser(input: { email: string; displayName: string; password: string }): User {
  const u: User = {
    id: `u_${randomUUID().slice(0, 8)}`,
    email: input.email,
    passwordHash: hashPassword(input.password),
    totpSecret: randomBase32Secret(),
    totpConfirmed: false,
    lastTotpStep: -1,
    displayName: input.displayName,
    notificationEmail: input.email,
  };
  db.users.set(u.id, u);
  return u;
}

export function findMembership(userId: string, tenantId: string): Membership | undefined {
  return db.memberships.find((m) => m.userId === userId && m.tenantId === tenantId);
}

/** Only the organizations this user belongs to. */
export function listOrganizations(userId: string) {
  return db.memberships
    .filter((m) => m.userId === userId)
    .map((m) => ({ ...db.tenants.get(m.tenantId)!, role: m.role }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A new organization, with its creator as the first Admin. */
export function createOrganization(userId: string, name: string): Tenant {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "org";
  const t: Tenant = { id: `t_${randomUUID().slice(0, 8)}`, slug: `${base}-${randomBytes(2).toString("hex")}`, name };
  db.tenants.set(t.id, t);
  db.memberships.push({ userId, tenantId: t.id, role: "admin" });
  return t;
}

// ---------------------------------------------------------------------------
// Team: members and pending invites. Always scoped to one organization.
// ---------------------------------------------------------------------------

export function listMembers(tenantId: string) {
  return db.memberships
    .filter((m) => m.tenantId === tenantId)
    .map((m) => {
      const u = db.users.get(m.userId)!;
      return { name: u.displayName, email: u.email, role: m.role };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function listInvites(tenantId: string): Invite[] {
  return [...db.invites.values()]
    .filter((i) => i.tenantId === tenantId)
    .sort((a, b) => a.invitedAt - b.invitedAt || a.email.localeCompare(b.email));
}

export function addInvite(tenantId: string, invitedBy: string, email: string, role: Role): Invite {
  const invite: Invite = {
    id: `inv_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    tenantId,
    email,
    role,
    invitedAt: Date.now(),
    invitedBy,
  };
  db.invites.set(invite.id, invite);
  return invite;
}

/** What the browser gets: no tenant or inviter IDs. */
export function toInviteDto(i: Invite) {
  return { id: i.id, email: i.email, role: i.role, invitedAt: i.invitedAt, status: "invited" as const };
}

/** False if there is no such invite in this organization (other organizations' invites are invisible). */
export function cancelInvite(tenantId: string, id: string): boolean {
  const invite = db.invites.get(id);
  if (!invite || invite.tenantId !== tenantId) return false;
  db.invites.delete(id);
  return true;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export function listDocuments(tenantId: string): DocumentRecord[] {
  const all = [...db.documents.values()];
  const visible = bug("tenant-leak") ? all : all.filter((d) => d.tenantId === tenantId);
  return visible.sort((a, b) => b.uploadedAt - a.uploadedAt || a.name.localeCompare(b.name));
}

export function getDocument(tenantId: string, id: string): DocumentRecord | undefined {
  const d = db.documents.get(id);
  return d && d.tenantId === tenantId ? d : undefined;
}

export function addDocument(
  tenantId: string,
  userId: string,
  name: string,
  sizeBytes: number,
  tableData: CsvTable,
): DocumentRecord {
  const d: DocumentRecord = {
    id: `doc_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    tenantId,
    name,
    sizeBytes,
    table: tableData,
    uploadedAt: Date.now(),
    uploadedBy: userId,
  };
  db.documents.set(d.id, d);
  return d;
}

export function deleteDocument(tenantId: string, id: string): boolean {
  const target = getDocument(tenantId, id);
  if (!target) return false;
  if (bug("delete-wrong-doc")) {
    // Regression: deletes the tenant's oldest document instead of the one asked for.
    const oldest = [...db.documents.values()]
      .filter((d) => d.tenantId === tenantId)
      .sort((a, b) => a.uploadedAt - b.uploadedAt)[0];
    db.documents.delete(oldest.id);
    return true;
  }
  db.documents.delete(id);
  return true;
}

// ---------------------------------------------------------------------------
// AI jobs
// ---------------------------------------------------------------------------

export const STAGES = ["queued", "reading", "analyzing", "writing", "complete"] as const;
export type Stage = (typeof STAGES)[number] | "failed";

function stageMs(): number {
  const v = Number(process.env.JOB_STAGE_MS);
  return Number.isFinite(v) && v > 0 ? v : 1500;
}

export function createJob(tenantId: string, doc: DocumentRecord): JobRecord {
  const job: JobRecord = {
    id: `job_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    tenantId,
    documentId: doc.id,
    documentName: doc.name,
    createdAt: Date.now(),
    analysisDoneAt: null,
    report: null,
    error: null,
  };
  db.jobs.set(job.id, job);

  analyse(doc.table)
    .then((report) => {
      if (bug("job-stuck")) return; // Regression: result is never recorded.
      if (bug("report-wrong-count")) {
        report = {
          ...report,
          findings: report.findings.map((f) =>
            f.metric === "total_events" ? { ...f, value: String(Number(f.value) + 1) } : f,
          ),
        };
      }
      job.report = report;
      job.analysisDoneAt = Date.now();
    })
    .catch((err: unknown) => {
      job.error =
        err instanceof AiJobError ? err.message : "The analysis failed unexpectedly.";
      job.analysisDoneAt = Date.now();
      if (!(err instanceof AiJobError)) console.error("[job]", job.id, err);
    });

  return job;
}

export function getJob(tenantId: string, id: string): JobRecord | undefined {
  const j = db.jobs.get(id);
  return j && j.tenantId === tenantId ? j : undefined;
}

export function listJobs(tenantId: string): JobRecord[] {
  return [...db.jobs.values()]
    .filter((j) => j.tenantId === tenantId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export type JobView = {
  id: string;
  documentId: string;
  documentName: string;
  status: "running" | "succeeded" | "failed";
  stage: Stage;
  progress: number;
  createdAt: number;
  error: string | null;
  report: Report | null;
};

/** Job state is derived from elapsed time, so it needs no background timers. */
export function jobView(job: JobRecord, now = Date.now()): JobView {
  const S = stageMs();
  const t = now - job.createdAt;
  const base = {
    id: job.id,
    documentId: job.documentId,
    documentName: job.documentName,
    createdAt: job.createdAt,
  };
  const lerp = (from: number, to: number, frac: number) =>
    Math.round(from + (to - from) * Math.min(Math.max(frac, 0), 1));

  if (t < S) return { ...base, status: "running", stage: "queued", progress: lerp(0, 10, t / S), error: null, report: null };
  if (t < 2 * S) return { ...base, status: "running", stage: "reading", progress: lerp(10, 35, (t - S) / S), error: null, report: null };

  const analyzingEnd = Math.max(job.createdAt + 3 * S, job.analysisDoneAt ?? Infinity);
  if (now < analyzingEnd) {
    return { ...base, status: "running", stage: "analyzing", progress: lerp(35, 75, (t - 2 * S) / S), error: null, report: null };
  }
  if (job.error) {
    return { ...base, status: "failed", stage: "failed", progress: 75, error: job.error, report: null };
  }
  if (now < analyzingEnd + S) {
    return { ...base, status: "running", stage: "writing", progress: lerp(80, 99, (now - analyzingEnd) / S), error: null, report: null };
  }
  return { ...base, status: "succeeded", stage: "complete", progress: 100, error: null, report: job.report };
}
