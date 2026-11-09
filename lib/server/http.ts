import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { resolveSession } from "@/lib/server/auth-store";

export const SESSION_COOKIE = "eclypse_session";
export const CHALLENGE_COOKIE = "eclypse_mfa";

export function jsonError(status: number, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

/** Signed in (password + code), whether or not an organization is picked yet. */
export async function requireUser(req: NextRequest) {
  const auth = await resolveSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!auth) return { auth: null, denied: jsonError(401, "Please sign in.") } as const;
  return { auth, denied: null } as const;
}

/** Signed in AND working inside an organization. Everything with data needs this. */
export async function requireAuth(req: NextRequest) {
  const auth = await resolveSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!auth) return { auth: null, denied: jsonError(401, "Please sign in.") } as const;
  const { tenant, role } = auth;
  if (!tenant || !role) {
    return { auth: null, denied: jsonError(403, "Choose an organization first.", { code: "no-organization" }) } as const;
  }
  return { auth: { ...auth, tenant, role }, denied: null } as const;
}

export const READ_ONLY_MESSAGE = "You have read-only access (Viewer). Ask an admin of this organization to make this change.";

/** Like requireAuth, but only an Admin of the organization gets through. Every change to data needs this. */
export async function requireAdmin(req: NextRequest) {
  const { auth, denied } = await requireAuth(req);
  if (denied) return { auth: null, denied } as const;
  if (auth.role !== "admin") {
    return { auth: null, denied: jsonError(403, READ_ONLY_MESSAGE, { code: "read-only" }) } as const;
  }
  return { auth, denied: null } as const;
}

export const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production" && process.env.INSECURE_COOKIES !== "1",
};
