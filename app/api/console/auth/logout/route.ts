import { NextResponse, type NextRequest } from "next/server";
import { CONSOLE_SESSION_COOKIE } from "@/lib/console/contract";
import { deleteSession } from "@/lib/console/server/store";

// Ends the console session. Works without a valid session too, like the
// platform's logout, so an expired session can still clear its cookie.
export async function POST(req: NextRequest) {
  const id = req.cookies.get(CONSOLE_SESSION_COOKIE)?.value;
  if (id) await deleteSession(id);
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(CONSOLE_SESSION_COOKIE);
  return res;
}
