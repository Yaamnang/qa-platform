import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { jsonError, setChallengeCookie } from "@/lib/console/server/http";
import { createChallenge, findEmployeeByEmail } from "@/lib/console/server/store";
import { checkPassword, hashPassword } from "@/lib/server/password";

/**
 * Checked against when the email is unknown, so an unknown email costs the
 * same scrypt work as a wrong password. Otherwise the response time alone
 * would tell an outsider which addresses belong to employees.
 */
const NOBODY_HASH = hashPassword(randomUUID());

// Step 1 of console sign-in: email and password. Same flow as the platform's
// (app/api/auth/login), against the console's own employees. On success the
// browser gets a short-lived challenge cookie and must then send a code.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!email || !password) return jsonError(400, "Enter your email and password.");

  const employee = await findEmployeeByEmail(email);
  const passwordOk = checkPassword(password, employee?.passwordHash ?? NOBODY_HASH);
  if (!employee || !passwordOk) return jsonError(401, "Incorrect email or password.");

  const challenge = await createChallenge(employee.id);
  // An employee who has never confirmed an authenticator sets one up first.
  const res = NextResponse.json({ next: employee.totpConfirmed ? "verify" : "setup" });
  setChallengeCookie(res, challenge.id);
  return res;
}
