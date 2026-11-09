import { connection, NextResponse } from "next/server";
import { aiMode } from "@/lib/server/ai";

export async function GET() {
  await connection(); // evaluate per request, never prerender
  return NextResponse.json({ ok: true, aiMode: aiMode() }, { headers: { "cache-control": "no-store" } });
}
