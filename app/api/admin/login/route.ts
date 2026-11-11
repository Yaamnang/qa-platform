import { NextResponse, type NextRequest } from "next/server";
import { adminEnabled, setAdminCookie, signIn } from "@/lib/admin/auth";
import { jsonError } from "@/lib/server/http";

// Admin sign-in: the fixed account from ADMIN_EMAIL and ADMIN_PASSWORD, plus the code from the phone that scanned ADMIN_TOTP_SECRET. Three wrong tries close it for 15 minutes.
export async function POST(req: NextRequest) {
  if (!adminEnabled()) return jsonError(404, "Not found.");
  const body = (await req.json().catch(() => null)) as { email?: unknown; password?: unknown; code?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const code = typeof body?.code === "string" ? body.code : "";
  if (!email || !password || !code) return jsonError(400, "Enter the admin email, password and code.");

  const result = signIn(email, password, code);
  if (!result.ok) return jsonError(result.status, result.message);
  const res = NextResponse.json({ ok: true });
  setAdminCookie(res, result.sessionId);
  return res;
}
