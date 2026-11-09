import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import { cookieOptions, jsonError } from "@/lib/server/http";
import { CONSOLE_CHALLENGE_COOKIE, CONSOLE_SESSION_COOKIE } from "../contract";
import { ConsoleKeyError } from "./encryption";
import { tokenMatches } from "./chat";
import { GithubApiError } from "./github";
import { CONSOLE_CHALLENGE_TTL_MS, CONSOLE_SESSION_TTL_MS } from "./records";
import { defaultCallbackBase } from "./runner";
import { resolveSession } from "./store";

/**
 * Request helpers for the console's API routes. The console's version of
 * requireAuth in lib/server/http.ts: same shape, but it reads the console's
 * own cookie and the console's own session table, so a signed-in platform
 * user (the QA bot included) is a stranger here, and the other way round.
 *
 * jsonError and cookieOptions are the stand-in's, re-exported: they are
 * generic and the console should answer errors and set cookies the same way.
 */
export { jsonError };

/** Every console GET carries logs or job state, so nothing may be cached. */
export const NO_STORE = { "cache-control": "no-store" };

/**
 * A signed-in employee. Every console route except login, setup and verify
 * starts with this.
 *
 * A console session is only ever created after a code was accepted, so the
 * employee always has a confirmed authenticator. It is checked anyway: it
 * costs nothing and keeps the rule visible in the one place every route uses.
 */
export async function requireEmployee(req: NextRequest) {
  const resolved = await resolveSession(req.cookies.get(CONSOLE_SESSION_COOKIE)?.value);
  if (!resolved || !resolved.employee.totpConfirmed) {
    return { employee: null, denied: jsonError(401, "Please sign in to the console.") } as const;
  }
  return { employee: resolved.employee, session: resolved.session, denied: null } as const;
}

export function setChallengeCookie(res: NextResponse, challengeId: string) {
  res.cookies.set(CONSOLE_CHALLENGE_COOKIE, challengeId, { ...cookieOptions, maxAge: CONSOLE_CHALLENGE_TTL_MS / 1000 });
}

/** Signed in: the session cookie replaces the challenge cookie. */
export function setSessionCookie(res: NextResponse, sessionId: string) {
  res.cookies.set(CONSOLE_SESSION_COOKIE, sessionId, { ...cookieOptions, maxAge: CONSOLE_SESSION_TTL_MS / 1000 });
  res.cookies.delete(CONSOLE_CHALLENGE_COOKIE);
}

/**
 * The answer for a failed GitHub call or a missing console key in a GitHub
 * route. A GitHub failure is a 502: the console is fine, GitHub said no. Never
 * 401, which the pages read as "signed out of the console". Anything else is
 * rethrown, so a real bug still shows up as one.
 */
export function githubFailure(err: unknown) {
  if (err instanceof GithubApiError) return jsonError(502, err.message);
  if (err instanceof ConsoleKeyError) return jsonError(500, err.message);
  throw err;
}

/**
 * The run's own calls to its job chat (app/api/console/jobs/[id]/agent/*).
 * Only the job's callback token gets in; an employee session does not. Any
 * mismatch answers 404, so a guess learns nothing, not even that the job exists.
 */
export function requireJobToken(req: NextRequest, jobId: string) {
  return tokenMatches(jobId, req.headers.get("authorization")) ? null : jsonError(404, "Not found.");
}

/**
 * Where a job started from this request calls back to: loopback, on the port
 * this request came in on. Only the port is taken from the request, so the
 * token is never sent to another host.
 */
export function callbackBaseFor(req: NextRequest): string {
  const port = req.nextUrl.port;
  return defaultCallbackBase(/^\d+$/.test(port) ? port : undefined);
}
