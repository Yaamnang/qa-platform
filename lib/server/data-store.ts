import "server-only";
import { isSupabaseEnabled } from "./auth-store";
import type { CsvTable } from "./csv";
import {
  addDocument as memAddDocument,
  addInvite as memAddInvite,
  cancelInvite as memCancelInvite,
  createJob as memCreateJob,
  createOrganization as memCreateOrganization,
  db,
  deleteDocument as memDeleteDocument,
  getDocument as memGetDocument,
  getJob as memGetJob,
  listDocuments as memListDocuments,
  listInvites as memListInvites,
  listJobs as memListJobs,
  listMembers as memListMembers,
} from "./store";
import { supabaseDataBackend } from "./store-supabase-data";
import type { DocumentRecord, Invite, JobRecord, Role, Tenant } from "./store-types";

/**
 * Documents, AI jobs, team and settings, over either backend. The twin of
 * auth-store.ts, which does the same job for sign-in and organizations.
 *
 * Which backend is used is decided once, at module load, by whether the
 * Supabase environment variables are set. With none set the app uses the
 * in-memory store, which is the default and the path `npm run qa` takes on a
 * clean clone with no accounts.
 *
 * Routes must call these instead of touching `db` directly. Reaching into the
 * Maps works by accident on the in-memory backend, because the objects handed
 * out are live references and mutating one is the write. Against Postgres the
 * same code reads a copy and the change is silently lost, so every write has
 * an explicit method here.
 */

export type DataBackend = {
  listDocuments(tenantId: string): Promise<DocumentRecord[]>;
  getDocument(tenantId: string, id: string): Promise<DocumentRecord | undefined>;
  addDocument(
    tenantId: string,
    userId: string,
    name: string,
    sizeBytes: number,
    table: CsvTable,
  ): Promise<DocumentRecord>;
  deleteDocument(tenantId: string, id: string): Promise<boolean>;
  createJob(tenantId: string, doc: DocumentRecord): Promise<JobRecord>;
  getJob(tenantId: string, id: string): Promise<JobRecord | undefined>;
  listJobs(tenantId: string): Promise<JobRecord[]>;
  listInvites(tenantId: string): Promise<Invite[]>;
  addInvite(tenantId: string, invitedBy: string, email: string, role: Role): Promise<Invite>;
  cancelInvite(tenantId: string, id: string): Promise<boolean>;
  listMembers(tenantId: string): Promise<Array<{ name: string; email: string; role: Role }>>;
  createOrganization(userId: string, name: string): Promise<Tenant>;
  updateUserSettings(
    userId: string,
    patch: { displayName: string; notificationEmail: string },
  ): Promise<void>;
};

/** The in-memory backend: the existing synchronous functions, wrapped to match the interface. */
const memoryBackend: DataBackend = {
  async listDocuments(tenantId) {
    return memListDocuments(tenantId);
  },
  async getDocument(tenantId, id) {
    return memGetDocument(tenantId, id);
  },
  async addDocument(tenantId, userId, name, sizeBytes, table) {
    return memAddDocument(tenantId, userId, name, sizeBytes, table);
  },
  async deleteDocument(tenantId, id) {
    return memDeleteDocument(tenantId, id);
  },
  async createJob(tenantId, doc) {
    // store.ts records the result by mutating this object later, which works
    // because it is the object in the Map. See createJob in the Supabase
    // adapter for what has to happen instead when it is a row.
    return memCreateJob(tenantId, doc);
  },
  async getJob(tenantId, id) {
    return memGetJob(tenantId, id);
  },
  async listJobs(tenantId) {
    return memListJobs(tenantId);
  },
  async listInvites(tenantId) {
    return memListInvites(tenantId);
  },
  async addInvite(tenantId, invitedBy, email, role) {
    return memAddInvite(tenantId, invitedBy, email, role);
  },
  async cancelInvite(tenantId, id) {
    return memCancelInvite(tenantId, id);
  },
  async listMembers(tenantId) {
    return memListMembers(tenantId);
  },
  async createOrganization(userId, name) {
    return memCreateOrganization(userId, name);
  },
  async updateUserSettings(userId, patch) {
    const user = db.users.get(userId);
    if (user) Object.assign(user, patch);
  },
};

const backend: DataBackend = isSupabaseEnabled() ? supabaseDataBackend : memoryBackend;

export const listDocuments: DataBackend["listDocuments"] = (t) => backend.listDocuments(t);
export const getDocument: DataBackend["getDocument"] = (t, id) => backend.getDocument(t, id);
export const addDocument: DataBackend["addDocument"] = (t, u, n, s, tb) =>
  backend.addDocument(t, u, n, s, tb);
export const deleteDocument: DataBackend["deleteDocument"] = (t, id) => backend.deleteDocument(t, id);
export const createJob: DataBackend["createJob"] = (t, d) => backend.createJob(t, d);
export const getJob: DataBackend["getJob"] = (t, id) => backend.getJob(t, id);
export const listJobs: DataBackend["listJobs"] = (t) => backend.listJobs(t);
export const listInvites: DataBackend["listInvites"] = (t) => backend.listInvites(t);
export const addInvite: DataBackend["addInvite"] = (t, by, e, r) => backend.addInvite(t, by, e, r);
export const cancelInvite: DataBackend["cancelInvite"] = (t, id) => backend.cancelInvite(t, id);
export const listMembers: DataBackend["listMembers"] = (t) => backend.listMembers(t);
export const createOrganization: DataBackend["createOrganization"] = (u, n) =>
  backend.createOrganization(u, n);
export const updateUserSettings: DataBackend["updateUserSettings"] = (u, p) =>
  backend.updateUserSettings(u, p);

/**
 * Pure helpers that need no storage, re-exported so a route has one data
 * import. jobView derives stage and progress from a job's timestamps;
 * toInviteDto drops the tenant and inviter ids before an invite is sent to
 * the browser.
 */
export { jobView, toInviteDto } from "./store";
