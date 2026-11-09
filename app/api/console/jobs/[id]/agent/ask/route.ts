import { NextResponse, type NextRequest } from "next/server";
import type { AskKind } from "@/lib/console/contract";
import { cancelAsk, pollAsk, runAsk } from "@/lib/console/server/chat";
import { jsonError, NO_STORE, requireJobToken } from "@/lib/console/server/http";

const KINDS: AskKind[] = ["login", "code", "text"];

// The run asks the employee something and then polls for the answer.
// Called by qa/lib/console-link.ts with the job's token only.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const denied = requireJobToken(req, id);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { kind?: unknown; prompt?: unknown; event?: unknown } | null;
  const kind = KINDS.find((k) => k === body?.kind);
  if (!kind) return jsonError(400, 'kind must be "login", "code" or "text".');
  const prompt = typeof body?.prompt === "string" ? body.prompt : "";
  const askId = runAsk(id, kind, prompt, typeof body?.event === "string" ? body.event.slice(0, 60) : undefined);
  if (!askId) return jsonError(404, "Not found.");
  return NextResponse.json({ askId });
}

// The answer, once there is one. Handed over once, then dropped from the server's memory.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const denied = requireJobToken(req, id);
  if (denied) return denied;
  const askId = req.nextUrl.searchParams.get("id") ?? "";
  return NextResponse.json(pollAsk(id, askId), { headers: NO_STORE });
}

// The run gave up waiting.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const denied = requireJobToken(req, id);
  if (denied) return denied;
  cancelAsk(id, req.nextUrl.searchParams.get("id") ?? "");
  return NextResponse.json({ ok: true });
}
