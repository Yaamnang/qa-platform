import "server-only";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  CHALLENGE_TTL_MS,
  SESSION_TTL_MS,
  type Challenge,
  type Membership,
  type ResolvedSession,
  type Role,
  type Session,
  type Tenant,
  type User,
} from "./store-types";
import { randomBase32Secret } from "./totp";

/**
 * Supabase-backed store: the auth subset only (users, challenges, sessions,
 * memberships, tenants). The in-memory store in store.ts stays the default.
 *
 * Everything else that is stored (documents, jobs, team, settings) lives in
 * store-supabase-data.ts and shares the client and the error helper below.
 *
 * Every method mirrors its sync twin in store.ts: same id scheme, same TTLs,
 * same "expired counts as absent" rule, same return shapes. Only the storage
 * changes.
 */

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const USERS = "eclypse_users";
const CHALLENGES = "eclypse_challenges";
const SESSIONS = "eclypse_sessions";
const MEMBERSHIPS = "eclypse_memberships";
const TENANTS = "eclypse_tenants";

let cached: SupabaseClient | null = null;

/**
 * One client per process, built on first use, so importing this file without
 * Supabase configured does not throw. The secret key bypasses row level
 * security, which is what the schema relies on for isolation.
 *
 * Exported so store-supabase-data.ts uses this same single client.
 */
export function client(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    // Variable names only. Their values never reach a log or an error message.
    throw new Error("The Supabase store needs SUPABASE_URL and SUPABASE_SECRET_KEY.");
  }
  cached = createClient(url, secretKey, { auth: { persistSession: false } });
  return cached;
}

/** Postgres errors are bugs here, not user input problems, so they throw. */
export function assertOk(error: { message: string } | null, what: string): void {
  if (error) throw new Error(`Supabase ${what} failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Rows and mappers
//
// Postgres columns are snake_case, the app's types are camelCase, so every
// read goes through a mapper. Timestamps are bigint, which supabase-js can
// hand back as a string, hence Number() on those fields.
// ---------------------------------------------------------------------------

type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  totp_secret: string;
  totp_confirmed: boolean;
  last_totp_step: number | string;
  display_name: string;
  notification_email: string;
};

type ChallengeRow = {
  id: string;
  user_id: string;
  expires_at: number | string;
  attempts: number | string;
};

type SessionRow = {
  id: string;
  user_id: string;
  tenant_id: string | null;
  expires_at: number | string;
};

type MembershipRow = { user_id: string; tenant_id: string; role: Role };

type TenantRow = { id: string; slug: string; name: string };

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    totpSecret: row.totp_secret,
    totpConfirmed: row.totp_confirmed,
    lastTotpStep: Number(row.last_totp_step),
    displayName: row.display_name,
    notificationEmail: row.notification_email,
  };
}

function rowToChallenge(row: ChallengeRow): Challenge {
  return {
    id: row.id,
    userId: row.user_id,
    expiresAt: Number(row.expires_at),
    attempts: Number(row.attempts),
  };
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    expiresAt: Number(row.expires_at),
  };
}

function rowToMembership(row: MembershipRow): Membership {
  return { userId: row.user_id, tenantId: row.tenant_id, role: row.role };
}

function rowToTenant(row: TenantRow): Tenant {
  return { id: row.id, slug: row.slug, name: row.name };
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/**
 * Same scrypt scheme and same "salt:hash" format as hashPassword in store.ts,
 * so checkPassword there accepts rows written here. Copied rather than
 * imported: importing store.ts would build and seed the whole in-memory
 * database as a side effect of using the Supabase one.
 */
function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * ilike is a LIKE pattern, so % _ * and \ inside an address would act as
 * wildcards. Escaped, an email is matched whole and never as a pattern.
 */
function likeEscape(value: string): string {
  return value.replace(/[\\%_*]/g, (ch) => `\\${ch}`);
}

/** Case-insensitive, like the in-memory findUserByEmail. First match wins. */
async function findUserByEmail(email: string): Promise<User | undefined> {
  const needle = email.trim().toLowerCase();
  const { data, error } = await client()
    .from(USERS)
    .select("*")
    .ilike("email", likeEscape(needle))
    .limit(1);
  assertOk(error, "user lookup by email");
  const rows = (data ?? []) as UserRow[];
  return rows.length > 0 ? rowToUser(rows[0]) : undefined;
}

async function getUser(id: string): Promise<User | undefined> {
  const { data, error } = await client().from(USERS).select("*").eq("id", id).maybeSingle();
  assertOk(error, "user lookup");
  return data ? rowToUser(data as UserRow) : undefined;
}

/** New account from the sign-up form. Not usable until the authenticator is confirmed. */
async function createUser(input: {
  email: string;
  displayName: string;
  password: string;
}): Promise<User> {
  const user: User = {
    id: `u_${randomUUID().slice(0, 8)}`,
    email: input.email,
    passwordHash: hashPassword(input.password),
    totpSecret: randomBase32Secret(),
    totpConfirmed: false,
    lastTotpStep: -1,
    displayName: input.displayName,
    notificationEmail: input.email,
  };
  const { error } = await client().from(USERS).insert({
    id: user.id,
    email: user.email,
    password_hash: user.passwordHash,
    totp_secret: user.totpSecret,
    totp_confirmed: user.totpConfirmed,
    last_totp_step: user.lastTotpStep,
    display_name: user.displayName,
    notification_email: user.notificationEmail,
  });
  assertOk(error, "user insert");
  return user;
}

async function updateUser(
  id: string,
  patch: Partial<Pick<User, "totpConfirmed" | "lastTotpStep" | "displayName" | "notificationEmail">>,
): Promise<void> {
  // Only the fields actually passed are written, so one caller cannot clear
  // another caller's field by omitting it.
  const row: Record<string, unknown> = {};
  if (patch.totpConfirmed !== undefined) row.totp_confirmed = patch.totpConfirmed;
  if (patch.lastTotpStep !== undefined) row.last_totp_step = patch.lastTotpStep;
  if (patch.displayName !== undefined) row.display_name = patch.displayName;
  if (patch.notificationEmail !== undefined) row.notification_email = patch.notificationEmail;
  if (Object.keys(row).length === 0) return;

  const { error } = await client().from(USERS).update(row).eq("id", id);
  assertOk(error, "user update");
}

// ---------------------------------------------------------------------------
// Challenges (sign-in step 2)
// ---------------------------------------------------------------------------

async function createChallenge(userId: string): Promise<Challenge> {
  const challenge: Challenge = {
    id: randomBytes(24).toString("base64url"),
    userId,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
    attempts: 0,
  };
  const { error } = await client().from(CHALLENGES).insert({
    id: challenge.id,
    user_id: challenge.userId,
    expires_at: challenge.expiresAt,
    attempts: challenge.attempts,
  });
  assertOk(error, "challenge insert");
  return challenge;
}

/** An expired challenge counts as absent, exactly as in the in-memory store. */
async function getChallenge(id: string): Promise<Challenge | undefined> {
  const { data, error } = await client().from(CHALLENGES).select("*").eq("id", id).maybeSingle();
  assertOk(error, "challenge lookup");
  if (!data) return undefined;
  const challenge = rowToChallenge(data as ChallengeRow);
  if (challenge.expiresAt < Date.now()) return undefined;
  return challenge;
}

/**
 * The schema has no increment function, so this is a read then a write. The
 * in-memory `challenge.attempts++` is not atomic either.
 */
async function bumpChallengeAttempts(id: string): Promise<void> {
  const { data, error } = await client()
    .from(CHALLENGES)
    .select("attempts")
    .eq("id", id)
    .maybeSingle();
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

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

async function createSession(userId: string): Promise<Session> {
  const session: Session = {
    id: randomBytes(32).toString("base64url"),
    userId,
    tenantId: null,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  const { error } = await client().from(SESSIONS).insert({
    id: session.id,
    user_id: session.userId,
    tenant_id: session.tenantId,
    expires_at: session.expiresAt,
  });
  assertOk(error, "session insert");
  return session;
}

/**
 * The signed-in user, plus the organization they picked (null until they pick
 * one). Membership is re-checked on every request, so removing someone from an
 * organization takes effect immediately. An expired session counts as absent
 * and is left in place, as in the in-memory store.
 */
async function resolveSession(sessionId: string | undefined): Promise<ResolvedSession | null> {
  if (!sessionId) return null;
  const { data, error } = await client().from(SESSIONS).select("*").eq("id", sessionId).maybeSingle();
  assertOk(error, "session lookup");
  if (!data) return null;

  const session = rowToSession(data as SessionRow);
  if (session.expiresAt < Date.now()) return null;

  const user = await getUser(session.userId);
  if (!user) return null;

  const membership = session.tenantId
    ? await findMembership(user.id, session.tenantId)
    : undefined;
  const tenant = membership ? ((await getTenant(membership.tenantId)) ?? null) : null;
  return { session, user, tenant, role: membership?.role ?? null };
}

async function setSessionTenant(sessionId: string, tenantId: string): Promise<void> {
  const { error } = await client().from(SESSIONS).update({ tenant_id: tenantId }).eq("id", sessionId);
  assertOk(error, "session tenant update");
}

async function deleteSession(sessionId: string): Promise<void> {
  const { error } = await client().from(SESSIONS).delete().eq("id", sessionId);
  assertOk(error, "session delete");
}

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

async function getTenant(id: string): Promise<Tenant | undefined> {
  const { data, error } = await client().from(TENANTS).select("*").eq("id", id).maybeSingle();
  assertOk(error, "organization lookup");
  return data ? rowToTenant(data as TenantRow) : undefined;
}

async function findTenantBySlug(slug: string): Promise<Tenant | undefined> {
  const { data, error } = await client().from(TENANTS).select("*").eq("slug", slug).maybeSingle();
  assertOk(error, "organization lookup by slug");
  return data ? rowToTenant(data as TenantRow) : undefined;
}

async function findMembership(userId: string, tenantId: string): Promise<Membership | undefined> {
  const { data, error } = await client()
    .from(MEMBERSHIPS)
    .select("*")
    .eq("user_id", userId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  assertOk(error, "membership lookup");
  return data ? rowToMembership(data as MembershipRow) : undefined;
}

/** Only the organizations this user belongs to, sorted by name. */
async function listOrganizations(
  userId: string,
): Promise<Array<{ id: string; slug: string; name: string; role: Role }>> {
  const { data: membershipRows, error: membershipError } = await client()
    .from(MEMBERSHIPS)
    .select("*")
    .eq("user_id", userId);
  assertOk(membershipError, "membership list");

  const memberships = ((membershipRows ?? []) as MembershipRow[]).map(rowToMembership);
  if (memberships.length === 0) return [];

  // Two plain queries instead of an embedded join: easier to read, and the
  // tenant rows are needed whole anyway.
  const { data: tenantRows, error: tenantError } = await client()
    .from(TENANTS)
    .select("*")
    .in("id", memberships.map((m) => m.tenantId));
  assertOk(tenantError, "organization list");

  const tenants = new Map(
    ((tenantRows ?? []) as TenantRow[]).map((row) => [row.id, rowToTenant(row)] as const),
  );

  return memberships
    .flatMap((m) => {
      const tenant = tenants.get(m.tenantId);
      // A foreign key makes a missing tenant impossible; skipping beats throwing.
      return tenant ? [{ id: tenant.id, slug: tenant.slug, name: tenant.name, role: m.role }] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------

export const supabaseBackend = {
  findUserByEmail,
  getUser,
  createUser,
  updateUser,
  createChallenge,
  getChallenge,
  bumpChallengeAttempts,
  deleteChallenge,
  createSession,
  resolveSession,
  setSessionTenant,
  deleteSession,
  findMembership,
  listOrganizations,
  findTenantBySlug,
};
