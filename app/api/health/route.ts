import { connection, NextResponse } from "next/server";
import { aiMode } from "@/lib/server/ai";

export async function GET() {
  await connection(); // evaluate per request, never prerender
  // standIn: how the Probe tells our own stand-in (built-in suite) from any other site (AI Probe). See qa/probe/detect.ts.
  return NextResponse.json({ ok: true, standIn: true, aiMode: aiMode() }, { headers: { "cache-control": "no-store" } });
}
