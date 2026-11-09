import { connection, NextResponse } from "next/server";
import { CLIENT_BUGS, enabledBugs } from "@/lib/server/bugs";

// Feature flags for the browser. In the stand-in this is also how client-side
// fault injection reaches the UI (a bad flag is a realistic way to break a button).
export async function GET() {
  await connection(); // evaluate per request, never prerender
  const flags = enabledBugs().filter((b) => CLIENT_BUGS.includes(b));
  return NextResponse.json({ flags }, { headers: { "cache-control": "no-store" } });
}
