import { NextResponse, type NextRequest } from "next/server";
import { deleteSession } from "@/lib/server/auth-store";
import { SESSION_COOKIE } from "@/lib/server/http";

export async function POST(req: NextRequest) {
  const id = req.cookies.get(SESSION_COOKIE)?.value;
  if (id) await deleteSession(id);
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
