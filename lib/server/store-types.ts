/**
 * Shared data shapes for the stand-in platform.
 *
 * Extracted from store.ts so both backends (in-memory and Supabase) can import
 * them without importing each other. Types only: no runtime code, no secrets.
 */
import type { Report } from "./analysis";
import type { CsvTable } from "./csv";

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
export type Invite = {
  id: string;
  tenantId: string;
  email: string;
  role: Role;
  invitedAt: number;
  invitedBy: string;
};

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

/** What resolveSession returns once a session cookie has been checked. */
export type ResolvedSession = {
  session: Session;
  user: User;
  tenant: Tenant | null;
  role: Role | null;
};

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export const QA_TENANT_SLUG = "qa-synthetic";
export const CANARY_DOC_ID = "doc_qacanary_0001";
