import { NextResponse, type NextRequest } from "next/server";
import { createChallenge, createUser, findUserByEmail } from "@/lib/server/auth-store";
import { CHALLENGE_COOKIE, cookieOptions } from "@/lib/server/http";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Sign-up step 1: create the account. It cannot be used until step 2
// (authenticator setup) is done, so every account always has two factors.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, string | undefined> | null;
  const displayName = body?.displayName?.trim() ?? "";
  const email = body?.email?.trim().toLowerCase() ?? "";
  const password = body?.password ?? "";
  const confirmPassword = body?.confirmPassword ?? "";

  const fieldErrors: Record<string, string> = {};
  if (displayName.length < 2 || displayName.length > 60) fieldErrors.displayName = "Enter your name (2-60 characters).";
  if (!EMAIL.test(email)) fieldErrors.email = "Enter a valid email address.";
  else if (await findUserByEmail(email)) fieldErrors.email = "An account with this email already exists. Sign in instead.";
  if (password.length < 12) fieldErrors.password = "Use at least 12 characters.";
  if (confirmPassword !== password) fieldErrors.confirmPassword = "The passwords do not match.";
  if (Object.keys(fieldErrors).length) {
    return NextResponse.json({ error: "Please fix the highlighted fields.", fieldErrors }, { status: 422 });
  }

  const user = await createUser({ email, displayName, password });
  const challenge = await createChallenge(user.id);
  const res = NextResponse.json({ next: "setup" }, { status: 201 });
  res.cookies.set(CHALLENGE_COOKIE, challenge.id, { ...cookieOptions, maxAge: 600 });
  return res;
}
