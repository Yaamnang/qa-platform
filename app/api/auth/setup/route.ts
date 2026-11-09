import { NextResponse, type NextRequest } from "next/server";
import QRCode from "qrcode";
import {
  bumpChallengeAttempts,
  createSession,
  deleteChallenge,
  getChallenge,
  getUser,
  updateUser,
} from "@/lib/server/auth-store";
import { CHALLENGE_COOKIE, SESSION_COOKIE, cookieOptions, jsonError } from "@/lib/server/http";
import { verifyTotp } from "@/lib/server/totp";

const MAX_ATTEMPTS = 5;

/** The account being set up: only reachable right after sign-up (or a sign-in of an unfinished account). */
async function pendingUser(req: NextRequest) {
  const id = req.cookies.get(CHALLENGE_COOKIE)?.value;
  // getChallenge already drops expired challenges.
  const challenge = id ? await getChallenge(id) : undefined;
  if (!challenge) return null;
  const user = await getUser(challenge.userId);
  if (!user || user.totpConfirmed) return null;
  return { challenge, user };
}

// Sign-up step 2a: show the secret as a QR code for the authenticator app.
export async function GET(req: NextRequest) {
  const pending = await pendingUser(req);
  if (!pending) return jsonError(401, "This setup link has expired. Please sign in again.");
  const { user } = pending;
  const label = encodeURIComponent(`Eclypse:${user.email}`);
  const otpauthUri = `otpauth://totp/${label}?secret=${user.totpSecret}&issuer=Eclypse&algorithm=SHA1&digits=6&period=30`;
  const qrSvg = await QRCode.toString(otpauthUri, { type: "svg", margin: 0, errorCorrectionLevel: "M" });
  return NextResponse.json({ email: user.email, secret: user.totpSecret, otpauthUri, qrSvg });
}

// Sign-up step 2b: the first code proves the app is set up. Then the user is signed in.
export async function POST(req: NextRequest) {
  const pending = await pendingUser(req);
  if (!pending) return jsonError(401, "This setup link has expired. Please sign in again.");
  const { challenge, user } = pending;
  if (challenge.attempts >= MAX_ATTEMPTS) {
    await deleteChallenge(challenge.id);
    return jsonError(429, "Too many incorrect codes. Please sign in again.");
  }

  const body = (await req.json().catch(() => null)) as { code?: string } | null;
  const step = verifyTotp(user.totpSecret, (body?.code ?? "").replace(/\s+/g, ""));
  if (step === null) {
    await bumpChallengeAttempts(challenge.id);
    return jsonError(401, "That code is not valid. Check the time on your phone and try the newest code.");
  }

  await updateUser(user.id, { totpConfirmed: true, lastTotpStep: step });
  await deleteChallenge(challenge.id);
  const session = await createSession(user.id);
  const res = NextResponse.json({ next: "/orgs" });
  res.cookies.set(SESSION_COOKIE, session.id, { ...cookieOptions, maxAge: 8 * 60 * 60 });
  res.cookies.delete(CHALLENGE_COOKIE);
  return res;
}
