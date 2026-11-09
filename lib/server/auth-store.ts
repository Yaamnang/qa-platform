import "server-only";
import { supabaseBackend } from "./store-supabase";
import {
  createChallenge as memCreateChallenge,
  createSession as memCreateSession,
  createUser as memCreateUser,
  db,
  findMembership as memFindMembership,
  findUserByEmail as memFindUserByEmail,
  listOrganizations as memListOrganizations,
  resolveSession as memResolveSession,
} from "./store";
import type { Challenge, Membership, ResolvedSession, Role, Session, Tenant, User } from "./store-types";

/**
 * Sign-in, sign-up and organization selection, over either backend.
 *
 * Which one is decided once, at module load, by whether the Supabase
 * environment variables are set. With none set the app uses the in-memory
 * store, which is the default and the path `npm run qa` takes on a clean
 * clone with no accounts.
 *
 * Routes must call these instead of touching `db` directly. Reaching into the
 * Maps works by accident on the in-memory backend, because the objects handed
 * out are live references and mutating one is the write. Against Postgres the
 * same code reads a copy and the change is silently lost, so every write has
 * an explicit method here.
 */

export type AuthBackend = {
  findUserByEmail(email: string): Promise<User | undefined>;
  getUser(id: string): Promise<User | undefined>;
  createUser(input: { email: string; displayName: string; password: string }): Promise<User>;
  updateUser(
    id: string,
    patch: Partial<Pick<User, "totpConfirmed" | "lastTotpStep" | "displayName" | "notificationEmail">>,
  ): Promise<void>;
  createChallenge(userId: string): Promise<Challenge>;
  getChallenge(id: string): Promise<Challenge | undefined>;
  bumpChallengeAttempts(id: string): Promise<void>;
  deleteChallenge(id: string): Promise<void>;
  createSession(userId: string): Promise<Session>;
  resolveSession(sessionId: string | undefined): Promise<ResolvedSession | null>;
  setSessionTenant(sessionId: string, tenantId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  findMembership(userId: string, tenantId: string): Promise<Membership | undefined>;
  listOrganizations(userId: string): Promise<Array<{ id: string; slug: string; name: string; role: Role }>>;
  findTenantBySlug(slug: string): Promise<Tenant | undefined>;
};

/** The in-memory backend: the existing Maps, wrapped to match the interface. */
const memoryBackend: AuthBackend = {
  async findUserByEmail(email) {
    return memFindUserByEmail(email);
  },
  async getUser(id) {
    return db.users.get(id);
  },
  async createUser(input) {
    return memCreateUser(input);
  },
  async updateUser(id, patch) {
    const user = db.users.get(id);
    if (user) Object.assign(user, patch);
  },
  async createChallenge(userId) {
    return memCreateChallenge(userId);
  },
  async getChallenge(id) {
    const c = db.challenges.get(id);
    return c && c.expiresAt >= Date.now() ? c : undefined;
  },
  async bumpChallengeAttempts(id) {
    const c = db.challenges.get(id);
    if (c) c.attempts++;
  },
  async deleteChallenge(id) {
    db.challenges.delete(id);
  },
  async createSession(userId) {
    return memCreateSession(userId);
  },
  async resolveSession(sessionId) {
    return memResolveSession(sessionId);
  },
  async setSessionTenant(sessionId, tenantId) {
    const s = db.sessions.get(sessionId);
    if (s) s.tenantId = tenantId;
  },
  async deleteSession(sessionId) {
    db.sessions.delete(sessionId);
  },
  async findMembership(userId, tenantId) {
    return memFindMembership(userId, tenantId);
  },
  async listOrganizations(userId) {
    return memListOrganizations(userId);
  },
  async findTenantBySlug(slug) {
    return [...db.tenants.values()].find((t) => t.slug === slug);
  },
};

/**
 * Supabase is opt-in, never inferred from credentials merely being present.
 *
 * Two reasons. A clean clone with no setup must run the whole suite on the
 * in-memory store, which is a stated requirement, and that has to hold even
 * on a machine that happens to have Supabase variables lying around in a
 * .env file. And a developer with credentials configured should still be able
 * to work offline without the app trying to reach the network.
 *
 * So: STORE=supabase turns it on, and the credentials must also be there.
 */
export function isSupabaseEnabled(): boolean {
  if (process.env.STORE !== "supabase") return false;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    throw new Error("STORE=supabase needs SUPABASE_URL and SUPABASE_SECRET_KEY to be set.");
  }
  return true;
}

const backend: AuthBackend = isSupabaseEnabled() ? supabaseBackend : memoryBackend;

/** Which backend is live. Reported by /api/health so a run records what it tested. */
export const authBackendName = isSupabaseEnabled() ? "supabase" : "memory";

export const findUserByEmail: AuthBackend["findUserByEmail"] = (e) => backend.findUserByEmail(e);
export const getUser: AuthBackend["getUser"] = (id) => backend.getUser(id);
export const createUser: AuthBackend["createUser"] = (i) => backend.createUser(i);
export const updateUser: AuthBackend["updateUser"] = (id, p) => backend.updateUser(id, p);
export const createChallenge: AuthBackend["createChallenge"] = (u) => backend.createChallenge(u);
export const getChallenge: AuthBackend["getChallenge"] = (id) => backend.getChallenge(id);
export const bumpChallengeAttempts: AuthBackend["bumpChallengeAttempts"] = (id) => backend.bumpChallengeAttempts(id);
export const deleteChallenge: AuthBackend["deleteChallenge"] = (id) => backend.deleteChallenge(id);
export const createSession: AuthBackend["createSession"] = (u) => backend.createSession(u);
export const resolveSession: AuthBackend["resolveSession"] = (s) => backend.resolveSession(s);
export const setSessionTenant: AuthBackend["setSessionTenant"] = (s, t) => backend.setSessionTenant(s, t);
export const deleteSession: AuthBackend["deleteSession"] = (s) => backend.deleteSession(s);
export const findMembership: AuthBackend["findMembership"] = (u, t) => backend.findMembership(u, t);
export const listOrganizations: AuthBackend["listOrganizations"] = (u) => backend.listOrganizations(u);
export const findTenantBySlug: AuthBackend["findTenantBySlug"] = (s) => backend.findTenantBySlug(s);
