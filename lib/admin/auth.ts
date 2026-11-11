import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { normalizeTotpSecret } from "@/lib/console/server/projects";
import { cookieOptions, jsonError } from "@/lib/server/http";
import { verifyTotp } from "@/lib/server/totp";

/**
 * Sign-in for the /admin portal, where employees of the QA console are added,
 * removed and reset.
 *
 * One fixed account, from the environment: ADMIN_EMAIL, ADMIN_PASSWORD and
 * ADMIN_TOTP_SECRET, the key the admin's phone scanned (`npm run admin --
 * admin-key` makes it and shows the QR code). Signing in takes all three: the
 * email, the password and the current six-digit code from the phone. So a
 * leaked password is not enough on its own. With any of them missing, a
 * password under 16 characters or a key that is not valid base32, the portal
 * does not exist: every /admin page and API answers 404.
 *
 * A code is accepted once. A second sign-in with the same code is refused,
 * so a code seen over someone's shoulder cannot be reused.
 *
 * Wrong tries: any wrong field counts, and the message does not say which
 * one. After 3 the sign-in closes for 15 minutes, for everyone. A
 * per-address limit was not used because the address comes from a header a
 * caller can fake, so it could be dodged. `npm run admin` in a terminal still
 * works while it is closed.
 *
 * Sessions are random ids kept in this process's memory for 30 minutes. A
 * restart signs the admin out, which is fine for a page used rarely.
 */

export const ADMIN_COOKIE = "eclypse_admin";
const MIN_PASSWORD_LENGTH = 16;
const MAX_FAILURES = 3;
const LOCK_MS = 15 * 60_000;
const SESSION_MS = 30 * 60_000;

type AdminState = { failures: number; lockedUntil: number; lastStep: number; sessions: Map<string, number> };
// On globalThis so a hot reload in development keeps the lock, the last code and the sessions.
const globalForAdmin = globalThis as unknown as { __eclypseAdmin?: AdminState };
const state = (): AdminState =>
  (globalForAdmin.__eclypseAdmin ??= { failures: 0, lockedUntil: 0, lastStep: -1, sessions: new Map() });

const adminKey = (): string | null => normalizeTotpSecret(process.env.ADMIN_TOTP_SECRET ?? "");

export function adminEnabled(): boolean {
  return (
    Boolean(process.env.ADMIN_EMAIL?.trim()) &&
    (process.env.ADMIN_PASSWORD ?? "").length >= MIN_PASSWORD_LENGTH &&
    adminKey() !== null
  );
}

/** Compares hashes, so the time taken says nothing about the value or its length. */
function same(given: string, expected: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

export type SignInResult = { ok: true; sessionId: string } | { ok: false; status: 401 | 429; message: string };

export function signIn(email: string, password: string, code: string): SignInResult {
  const s = state();
  const now = Date.now();
  if (s.lockedUntil > now) {
    const minutes = Math.ceil((s.lockedUntil - now) / 60_000);
    return { ok: false, status: 429, message: `Too many wrong tries. Admin sign-in is closed for ${minutes} more minute${minutes === 1 ? "" : "s"}.` };
  }
  // All three are always checked, so the answer and its timing do not say which one was wrong.
  const emailOk = same(email.trim().toLowerCase(), process.env.ADMIN_EMAIL!.trim().toLowerCase());
  const passwordOk = same(password, process.env.ADMIN_PASSWORD!);
  const step = verifyTotp(adminKey()!, code.trim());
  const codeOk = step !== null && step > s.lastStep;
  if (!emailOk || !passwordOk || !codeOk) {
    s.failures++;
    if (s.failures >= MAX_FAILURES) {
      s.failures = 0;
      s.lockedUntil = now + LOCK_MS;
      return { ok: false, status: 429, message: "Too many wrong tries. Admin sign-in is closed for 15 minutes." };
    }
    const left = MAX_FAILURES - s.failures;
    return { ok: false, status: 401, message: `Incorrect email, password or code. ${left} ${left === 1 ? "try" : "tries"} left.` };
  }
  s.failures = 0;
  s.lastStep = step;
  const sessionId = randomBytes(32).toString("base64url");
  s.sessions.set(sessionId, now + SESSION_MS);
  return { ok: true, sessionId };
}

export function signOut(sessionId: string | undefined) {
  if (sessionId) state().sessions.delete(sessionId);
}

/**
 * The first line of every admin API route. 404 when the portal is off, so it
 * cannot be found; 401 without a live admin session.
 */
export function requireAdmin(req: NextRequest): NextResponse | null {
  if (!adminEnabled()) return jsonError(404, "Not found.");
  const id = req.cookies.get(ADMIN_COOKIE)?.value;
  const expires = id ? state().sessions.get(id) : undefined;
  if (!id || !expires || expires < Date.now()) {
    if (id) state().sessions.delete(id);
    return jsonError(401, "Please sign in as admin.");
  }
  return null;
}

export function setAdminCookie(res: NextResponse, sessionId: string) {
  res.cookies.set(ADMIN_COOKIE, sessionId, { ...cookieOptions, sameSite: "strict", maxAge: SESSION_MS / 1000 });
}

/** A new employee's password: letters and digits only, so a double-click in a terminal selects all of it. */
export function newEmployeePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  // 256 is not a multiple of the alphabet's length, so bytes past the last full cycle are dropped to avoid bias.
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < 24) {
    for (const byte of randomBytes(32)) {
      if (byte < limit && out.length < 24) out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}
