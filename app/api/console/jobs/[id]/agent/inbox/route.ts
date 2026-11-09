import { NextResponse, type NextRequest } from "next/server";
import { drainInbox } from "@/lib/console/server/chat";
import { NO_STORE, requireJobToken } from "@/lib/console/server/http";

// Steering messages from the employee that the run has not read yet. Each is handed over once.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const denied = requireJobToken(req, id);
  if (denied) return denied;
  return NextResponse.json({ messages: drainInbox(id) }, { headers: NO_STORE });
}
