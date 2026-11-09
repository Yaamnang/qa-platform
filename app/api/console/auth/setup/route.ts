import { NextResponse, type NextRequest } from "next/server";
import QRCode from "qrcode";
import { CONSOLE_CHALLENGE_COOKIE } from "@/lib/console/contract";
import { NO_STORE, jsonError, setSessionCookie } from "@/lib/console/server/http";
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

/** The employee setting up an authenticator: only reachable right after a password sign-in, and only once. */
async function pendingEmployee(req: NextRequest) {
  const id = req.cookies.get(CONSOLE_CHALLENGE_COOKIE)?.value;
  // getChallenge already drops expired challenges.
  const challenge = id ? await getChallenge(id) : undefined;
  if (!challenge) return null;
  const employee = await getEmployee(challenge.employeeId);
  if (!employee || employee.totpConfirmed) return null;
  return { challenge, employee };
}

// First sign-in, step 2a: the authenticator secret, as text and as a QR code.
export async function GET(req: NextRequest) {
  const pending = await pendingEmployee(req);
  if (!pending) return jsonError(401, "This setup link has expired. Please sign in again.");
  const { employee } = pending;
  // Its own issuer, so an authenticator app lists the console apart from the platform.
  const label = encodeURIComponent(`Eclypse Console:${employee.email}`);
  const issuer = encodeURIComponent("Eclypse Console");
  const otpauthUri = `otpauth://totp/${label}?secret=${employee.totpSecret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
  const qrSvg = await QRCode.toString(otpauthUri, { type: "svg", margin: 0, errorCorrectionLevel: "M" });
  return NextResponse.json({ email: employee.email, secret: employee.totpSecret, otpauthUri, qrSvg }, { headers: NO_STORE });
}

// First sign-in, step 2b: the first code proves the app works. Then the employee is signed in.
export async function POST(req: NextRequest) {
  const pending = await pendingEmployee(req);
  if (!pending) return jsonError(401, "This setup link has expired. Please sign in again.");
  const { challenge, employee } = pending;
  if (challenge.attempts >= MAX_ATTEMPTS) {
    await deleteChallenge(challenge.id);
    return jsonError(429, "Too many incorrect codes. Please sign in again.");
  }

  const body = (await req.json().catch(() => null)) as { code?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code.replace(/\s+/g, "") : "";
  const step = verifyTotp(employee.totpSecret, code);
  if (step === null) {
    await bumpChallengeAttempts(challenge.id);
    return jsonError(401, "That code is not valid. Check the time on your phone and try the newest code.");
  }

  // Recording the step means this same code cannot be used again at verify.
  await updateEmployee(employee.id, { totpConfirmed: true, lastTotpStep: step });
  await deleteChallenge(challenge.id);
  const session = await createSession(employee.id);
  const res = NextResponse.json({ next: "/console" });
  setSessionCookie(res, session.id);
  return res;
}
