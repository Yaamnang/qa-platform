import { NextResponse, type NextRequest } from "next/server";
import type { LiveFrameMeta } from "@/lib/console/contract";
import { hasOpenLink } from "@/lib/console/server/chat";
import { NO_STORE, jsonError, requireEmployee } from "@/lib/console/server/http";
import { getFrame } from "@/lib/console/server/live-frames";
import { getJob } from "@/lib/console/server/store";

// What the latest live view frame shows, polled by the job page. The image itself is /frame.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { denied } = await requireEmployee(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  // A job running here certainly exists, so the store is only asked otherwise: this is polled twice a second.
  if (!hasOpenLink(id) && !(await getJob(id))) return jsonError(404, "Job not found.");
  const frame: LiveFrameMeta | null = getFrame(id)?.meta ?? null;
  return NextResponse.json({ frame }, { headers: NO_STORE });
}
