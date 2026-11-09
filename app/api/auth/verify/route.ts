import { NextResponse, type NextRequest } from "next/server";
import {
  bumpChallengeAttempts,
  createSession,
  deleteChallenge,
  getChallenge,
  getUser,
  updateUser,
} from "@/lib/server/auth-store";
import { bug } from "@/lib/server/bugs";
import { CHALLENGE_COOKIE, SESSION_COOKIE, cookieOptions, jsonError } from "@/lib/server/http";
import { verifyTotp } from "@/lib/server/totp";

const MAX_ATTEMPTS = 5;

// Step 2 of sign-in: the 6-digit code from the user's authenticator app.
export async function POST(req: NextRequest) {
  const challengeId = req.cookies.get(CHALLENGE_COOKIE)?.value;
  // getChallenge already drops expired challenges.
  const challenge = challengeId ? await getChallenge(challengeId) : undefined;
  if (!challenge) {
    return jsonError(401, "Your sign-in attempt expired. Please start again.");
  }
  if (challenge.attempts >= MAX_ATTEMPTS) {
    await deleteChallenge(challenge.id);
    return jsonError(429, "Too many incorrect codes. Please start again.");
  }

  const body = (await req.json().catch(() => null)) as { code?: string } | null;
  const code = (body?.code ?? "").replace(/\s+/g, "");
  const user = (await getUser(challenge.userId))!;
  if (!user.totpConfirmed) return jsonError(409, "Finish setting up your authenticator app first.");

  const step = bug("otp-rejects-valid") ? null : verifyTotp(user.totpSecret, code);
  if (step === null) {
    await bumpChallengeAttempts(challenge.id);
    return jsonError(401, "That code is not valid. Check your authenticator app and try again.");
  }
  if (step <= user.lastTotpStep) {
    await bumpChallengeAttempts(challenge.id);
    return jsonError(401, "That code has already been used. Wait for the next code.");
  }

  await updateUser(user.id, { lastTotpStep: step });
  await deleteChallenge(challenge.id);
  const session = await createSession(user.id);
  const res = NextResponse.json({ next: "/orgs" });
  res.cookies.set(SESSION_COOKIE, session.id, { ...cookieOptions, maxAge: 8 * 60 * 60 });
  res.cookies.delete(CHALLENGE_COOKIE);
  return res;
}
