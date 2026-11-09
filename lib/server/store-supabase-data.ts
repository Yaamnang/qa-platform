import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { analyse, AiJobError } from "./ai";
import type { Report } from "./analysis";
import { bug } from "./bugs";
import type { CsvTable } from "./csv";
import { assertOk, client } from "./store-supabase";
import type { DocumentRecord, Invite, JobRecord, Role, Tenant } from "./store-types";

/**
 * Supabase-backed store: documents, AI jobs, team invites and members,
 * organizations, and the two fields the settings form writes.
 *
 * Sibling of store-supabase.ts, which holds the auth subset. Split by subject
 * so neither file gets long; both use the client and the error helper from
 * there, so there is still one client per process.
 *
 * Every method mirrors its synchronous twin in store.ts: same id scheme, same
 * tenant scoping, same sort order, same injected bugs. Only the storage
 * changes.
 */

const DOCUMENTS = "eclypse_documents";
const JOBS = "eclypse_jobs";
const INVITES = "eclypse_invites";
const MEMBERSHIPS = "eclypse_memberships";
const TENANTS = "eclypse_tenants";
const USERS = "eclypse_users";

// ---------------------------------------------------------------------------
// Rows and mappers
//
// Postgres columns are snake_case, the app's types are camelCase, so every
// read goes through a mapper. Timestamps are bigint, which supabase-js can
// hand back as a string, hence Number() on those fields.
// ---------------------------------------------------------------------------

type DocumentRow = {
  id: string;
  tenant_id: string;
  name: string;
  size_bytes: number | string;
  /** The document's CsvTable, which is { header, rows }. "table" is a reserved word. */
  table_json: CsvTable;
  uploaded_at: number | string;
  uploaded_by: string;
};

type JobRow = {
  id: string;
  tenant_id: string;
  document_id: string;
  document_name: string;
  created_at: number | string;
  analysis_done_at: number | string | null;
  report: Report | null;
  error: string | null;
};

type InviteRow = {
  id: string;
  tenant_id: string;
  email: string;
  role: Role;
  invited_at: number | string;
  invited_by: string;
};

type MembershipRow = { user_id: string; tenant_id: string; role: Role };

type MemberUserRow = { id: string; display_name: string; email: string };

function rowToDocument(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    sizeBytes: Number(row.size_bytes),
    table: row.table_json,
    uploadedAt: Number(row.uploaded_at),
    uploadedBy: row.uploaded_by,
  };
}

function rowToJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    documentId: row.document_id,
    documentName: row.document_name,
    createdAt: Number(row.created_at),
    // Null means the analysis has not settled yet, so it must stay null.
    analysisDoneAt: row.analysis_done_at === null ? null : Number(row.analysis_done_at),
    report: row.report,
    error: row.error,
  };
}

function rowToInvite(row: InviteRow): Invite {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    role: row.role,
    invitedAt: Number(row.invited_at),
    invitedBy: row.invited_by,
  };
}

/**
 * Lists are sorted in JavaScript with the same comparators as the in-memory
 * store, not with ORDER BY. localeCompare and the database's collation do not
 * put names in the same order, and both backends have to produce the same
 * screen.
 */
const byUploadedAtThenName = (a: DocumentRecord, b: DocumentRecord) =>
  b.uploadedAt - a.uploadedAt || a.name.localeCompare(b.name);

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

async function listDocuments(tenantId: string): Promise<DocumentRecord[]> {
  const query = client().from(DOCUMENTS).select("*");
  // Regression: the tenant filter is dropped, so other clients' documents show up.
  const { data, error } = bug("tenant-leak") ? await query : await query.eq("tenant_id", tenantId);
  assertOk(error, "document list");
  return ((data ?? []) as DocumentRow[]).map(rowToDocument).sort(byUploadedAtThenName);
}

/**
 * The tenant is part of the query, so another tenant's id simply does not
 * match and the caller gets undefined. That is a security property: the
 * routes turn it into a 404, which is also what a non-existent id gets, so
 * ids cannot be probed.
 */
async function getDocument(tenantId: string, id: string): Promise<DocumentRecord | undefined> {
  const { data, error } = await client()
    .from(DOCUMENTS)
    .select("*")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  assertOk(error, "document lookup");
  return data ? rowToDocument(data as DocumentRow) : undefined;
}

async function addDocument(
  tenantId: string,
  userId: string,
  name: string,
  sizeBytes: number,
  tableData: CsvTable,
): Promise<DocumentRecord> {
  const doc: DocumentRecord = {
    id: `doc_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    tenantId,
    name,
    sizeBytes,
    table: tableData,
    uploadedAt: Date.now(),
    uploadedBy: userId,
  };
  const { error } = await client().from(DOCUMENTS).insert({
    id: doc.id,
    tenant_id: doc.tenantId,
    name: doc.name,
    size_bytes: doc.sizeBytes,
    table_json: doc.table,
    uploaded_at: doc.uploadedAt,
    uploaded_by: doc.uploadedBy,
  });
  assertOk(error, "document insert");
  return doc;
}

async function deleteDocument(tenantId: string, id: string): Promise<boolean> {
  // Tenant-scoped read first: another tenant's id has to look like "not found"
  // and must not delete anything.
  const target = await getDocument(tenantId, id);
  if (!target) return false;

  let doomedId = target.id;
  if (bug("delete-wrong-doc")) {
    // Regression: deletes the tenant's oldest document instead of the one asked for.
    const { data, error } = await client()
      .from(DOCUMENTS)
      .select("id")
      .eq("tenant_id", tenantId)
      .order("uploaded_at", { ascending: true })
      // Second key only so a tie between two equal timestamps is settled the
      // same way on every call. Which document is picked does not matter: the
      // point of the bug is that it is not the one the user asked for.
      .order("id", { ascending: true })
      .limit(1);
    assertOk(error, "oldest document lookup");
    const oldest = (data ?? []) as Array<{ id: string }>;
    if (oldest.length > 0) doomedId = oldest[0].id;
  }

  const { error } = await client().from(DOCUMENTS).delete().eq("id", doomedId).eq("tenant_id", tenantId);
  assertOk(error, "document delete");
  return true;
}

// ---------------------------------------------------------------------------
// AI jobs
// ---------------------------------------------------------------------------

/**
 * Start an analysis and return the new job straight away.
 *
 * This is the one place where the two backends cannot share a shape. In
 * store.ts the job object handed back is the one living in the Map, so the
 * `job.report = report` inside `.then()` IS the write, however long after the
 * function returned it happens. Here the object is a copy of a row, so that
 * assignment would change nothing anybody can read: the job would sit at
 * "Analyzing" forever, because jobView treats a null analysis_done_at as
 * "still running". So the deferred write is an explicit UPDATE of the row,
 * made when the analysis settles.
 *
 * The analysis starts only after the insert is confirmed, so the UPDATE can
 * never reach the database before the row it updates. Nothing waits for the
 * result: the route answers 202 immediately, as before.
 */
async function createJob(tenantId: string, doc: DocumentRecord): Promise<JobRecord> {
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
  const { error } = await client().from(JOBS).insert({
    id: job.id,
    tenant_id: job.tenantId,
    document_id: job.documentId,
    document_name: job.documentName,
    created_at: job.createdAt,
    analysis_done_at: job.analysisDoneAt,
    report: job.report,
    error: job.error,
  });
  assertOk(error, "job insert");

  recordResult(job.id, doc.table).catch((err: unknown) => {
    // Nothing is waiting on this promise, so a failure here would otherwise
    // disappear. The job then stays unfinished, which is the truth: its
    // result was never recorded.
    console.error("[job]", job.id, "could not record the analysis result:", err);
  });

  return job;
}

/**
 * The deferred write. Mirrors the .then() / .catch() pair in store.ts,
 * injected bugs included. The switches are repeated rather than shared
 * because store.ts stays synchronous; the two copies have to be kept in step.
 */
async function recordResult(jobId: string, table: CsvTable): Promise<void> {
  let patch: Record<string, unknown>;
  try {
    let report = await analyse(table);
    if (bug("job-stuck")) return; // Regression: result is never recorded.
    if (bug("report-wrong-count")) {
      report = {
        ...report,
        findings: report.findings.map((f) =>
          f.metric === "total_events" ? { ...f, value: String(Number(f.value) + 1) } : f,
        ),
      };
    }
    patch = { report, analysis_done_at: Date.now() };
  } catch (err: unknown) {
    patch = {
      error: err instanceof AiJobError ? err.message : "The analysis failed unexpectedly.",
      analysis_done_at: Date.now(),
    };
    if (!(err instanceof AiJobError)) console.error("[job]", jobId, err);
  }

  // The job id is enough: a job's tenant cannot change, and the caller that
  // started this analysis was already scoped to the tenant.
  const { error } = await client().from(JOBS).update(patch).eq("id", jobId);
  assertOk(error, "job result update");
}

async function getJob(tenantId: string, id: string): Promise<JobRecord | undefined> {
  const { data, error } = await client()
    .from(JOBS)
    .select("*")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  assertOk(error, "job lookup");
  return data ? rowToJob(data as JobRow) : undefined;
}

async function listJobs(tenantId: string): Promise<JobRecord[]> {
  const { data, error } = await client().from(JOBS).select("*").eq("tenant_id", tenantId);
  assertOk(error, "job list");
  return ((data ?? []) as JobRow[]).map(rowToJob).sort((a, b) => b.createdAt - a.createdAt);
}

// ---------------------------------------------------------------------------
// Team: members and pending invites. Always scoped to one organization.
// ---------------------------------------------------------------------------

async function listInvites(tenantId: string): Promise<Invite[]> {
  const { data, error } = await client().from(INVITES).select("*").eq("tenant_id", tenantId);
  assertOk(error, "invite list");
  return ((data ?? []) as InviteRow[])
    .map(rowToInvite)
    .sort((a, b) => a.invitedAt - b.invitedAt || a.email.localeCompare(b.email));
}

async function addInvite(
  tenantId: string,
  invitedBy: string,
  email: string,
  role: Role,
): Promise<Invite> {
  const invite: Invite = {
    id: `inv_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    tenantId,
    email,
    role,
    invitedAt: Date.now(),
    invitedBy,
  };
  const { error } = await client().from(INVITES).insert({
    id: invite.id,
    tenant_id: invite.tenantId,
    email: invite.email,
    role: invite.role,
    invited_at: invite.invitedAt,
    invited_by: invite.invitedBy,
  });
  assertOk(error, "invite insert");
  return invite;
}

/** False if there is no such invite in this organization (other organizations' invites are invisible). */
async function cancelInvite(tenantId: string, id: string): Promise<boolean> {
  // A delete that returns what it removed answers both questions at once:
  // nothing came back means there was no such invite in this organization.
  const { data, error } = await client()
    .from(INVITES)
    .delete()
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .select("id");
  assertOk(error, "invite delete");
  return ((data ?? []) as Array<{ id: string }>).length > 0;
}

async function listMembers(
  tenantId: string,
): Promise<Array<{ name: string; email: string; role: Role }>> {
  const { data: membershipRows, error: membershipError } = await client()
    .from(MEMBERSHIPS)
    .select("*")
    .eq("tenant_id", tenantId);
  assertOk(membershipError, "member list");

  const memberships = (membershipRows ?? []) as MembershipRow[];
  if (memberships.length === 0) return [];

  // Two plain queries instead of an embedded join, as in the auth adapter.
  const { data: userRows, error: userError } = await client()
    .from(USERS)
    .select("id, display_name, email")
    .in("id", memberships.map((m) => m.user_id));
  assertOk(userError, "member user list");

  const users = new Map(((userRows ?? []) as MemberUserRow[]).map((row) => [row.id, row] as const));

  return memberships
    .flatMap((m) => {
      const user = users.get(m.user_id);
      // A foreign key makes a missing user impossible; skipping beats throwing.
      return user ? [{ name: user.display_name, email: user.email, role: m.role }] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

/** A new organization, with its creator as the first Admin. */
async function createOrganization(userId: string, name: string): Promise<Tenant> {
  const base =
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "org";
  const tenant: Tenant = {
    id: `t_${randomUUID().slice(0, 8)}`,
    slug: `${base}-${randomBytes(2).toString("hex")}`,
    name,
  };
  const { error } = await client()
    .from(TENANTS)
    .insert({ id: tenant.id, slug: tenant.slug, name: tenant.name });
  assertOk(error, "organization insert");

  // Two statements, not a transaction: supabase-js cannot wrap these in one.
  // An organization without its first member would be unreachable, so if this
  // second insert fails the request fails too and says so.
  const { error: membershipError } = await client()
    .from(MEMBERSHIPS)
    .insert({ user_id: userId, tenant_id: tenant.id, role: "admin" });
  assertOk(membershipError, "organization membership insert");
  return tenant;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** The two fields the settings form owns. Nothing else about the user changes. */
async function updateUserSettings(
  userId: string,
  patch: { displayName: string; notificationEmail: string },
): Promise<void> {
  const { error } = await client()
    .from(USERS)
    .update({ display_name: patch.displayName, notification_email: patch.notificationEmail })
    .eq("id", userId);
  assertOk(error, "settings update");
}

// ---------------------------------------------------------------------------

export const supabaseDataBackend = {
  listDocuments,
  getDocument,
  addDocument,
  deleteDocument,
  createJob,
  getJob,
  listJobs,
  listInvites,
  addInvite,
  cancelInvite,
  listMembers,
  createOrganization,
  updateUserSettings,
};
