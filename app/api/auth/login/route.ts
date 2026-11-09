import { NextResponse, type NextRequest } from "next/server";
import { createChallenge, findUserByEmail } from "@/lib/server/auth-store";
import { CHALLENGE_COOKIE, cookieOptions, jsonError } from "@/lib/server/http";
import { checkPassword } from "@/lib/server/store";

// Step 1 of sign-in: email + password. On success the browser receives a
// short-lived challenge cookie and must then supply a one-time code.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { email?: string; password?: string } | null;
  const email = body?.email?.trim() ?? "";
  const password = body?.password ?? "";
  if (!email || !password) return jsonError(400, "Enter your email and password.");

  const user = await findUserByEmail(email);
  if (!user || !checkPassword(password, user.passwordHash)) {
    return jsonError(401, "Incorrect email or password.");
  }

  const challenge = await createChallenge(user.id);
  // An account whose authenticator was never confirmed finishes setup first.
  const res = NextResponse.json({ next: user.totpConfirmed ? "verify" : "setup" });
  res.cookies.set(CHALLENGE_COOKIE, challenge.id, { ...cookieOptions, maxAge: 300 });
  return res;
}
