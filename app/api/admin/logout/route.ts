import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_COOKIE, signOut } from "@/lib/admin/auth";

export async function POST(req: NextRequest) {
  signOut(req.cookies.get(ADMIN_COOKIE)?.value);
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(ADMIN_COOKIE);
  return res;
}
