import { NextResponse, type NextRequest } from "next/server";
import { CONSOLE_CHALLENGE_COOKIE } from "@/lib/console/contract";
import { jsonError, setSessionCookie } from "@/lib/console/server/http";
import {
  bumpChallengeAttempts,
  createSession,
  deleteChallenge,
  getChallenge,
  getEmployee,
  updateEmployee,
} from "@/lib/console/server/store";
import { verifyTotp } from "@/lib/server/totp";

const MAX_ATTEMPTS = 5;

// Step 2 of console sign-in: the six-digit code from the employee's authenticator app.
// Same rules as the platform's verify: five wrong codes end the attempt, and a code works once.
export async function POST(req: NextRequest) {
  const challengeId = req.cookies.get(CONSOLE_CHALLENGE_COOKIE)?.value;
  // getChallenge already drops expired challenges.
  const challenge = challengeId ? await getChallenge(challengeId) : undefined;
  if (!challenge) return jsonError(401, "Your sign-in attempt expired. Please start again.");
  if (challenge.attempts >= MAX_ATTEMPTS) {
    await deleteChallenge(challenge.id);
    return jsonError(429, "Too many incorrect codes. Please start again.");
  }

  const employee = await getEmployee(challenge.employeeId);
  if (!employee) return jsonError(401, "Your sign-in attempt expired. Please start again.");
  if (!employee.totpConfirmed) return jsonError(409, "Finish setting up your authenticator app first.");

  const body = (await req.json().catch(() => null)) as { code?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code.replace(/\s+/g, "") : "";
  const step = verifyTotp(employee.totpSecret, code);
  if (step === null) {
    await bumpChallengeAttempts(challenge.id);
    return jsonError(401, "That code is not valid. Check your authenticator app and try again.");
  }
  // Replay protection: a time step at or below the last accepted one has been used already.
  if (step <= employee.lastTotpStep) {
    await bumpChallengeAttempts(challenge.id);
    return jsonError(401, "That code has already been used. Wait for the next code.");
  }

  await updateEmployee(employee.id, { lastTotpStep: step });
  await deleteChallenge(challenge.id);
  const session = await createSession(employee.id);
  const res = NextResponse.json({ next: "/console" });
  setSessionCookie(res, session.id);
  return res;
}
