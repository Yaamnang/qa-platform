import { NextResponse, type NextRequest } from "next/server";
import { runSay } from "@/lib/console/server/chat";
import { jsonError, requireJobToken } from "@/lib/console/server/http";

// A note from the run for the job's chat. Called by qa/lib/console-link.ts with the job's token only.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const denied = requireJobToken(req, id);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { text?: unknown; event?: unknown } | null;
  if (typeof body?.text !== "string" || !body.text.trim()) return jsonError(400, "Send text.");
  runSay(id, body.text, typeof body.event === "string" ? body.event.slice(0, 60) : undefined);
  return NextResponse.json({ ok: true });
}
