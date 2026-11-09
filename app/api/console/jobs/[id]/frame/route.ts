import type { NextRequest } from "next/server";
import { hasOpenLink } from "@/lib/console/server/chat";
import { NO_STORE, jsonError, requireEmployee } from "@/lib/console/server/http";
import { getFrame } from "@/lib/console/server/live-frames";
import { getJob } from "@/lib/console/server/store";

// The job's latest live view frame as a JPEG. 204 when there is none (yet, or any more).
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { denied } = await requireEmployee(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  // A job running here certainly exists, so the store is only asked otherwise: this is polled twice a second.
  if (!hasOpenLink(id) && !(await getJob(id))) return jsonError(404, "Job not found.");
  const frame = getFrame(id);
  if (!frame) return new Response(null, { status: 204, headers: NO_STORE });
  return new Response(new Uint8Array(frame.bytes), {
    headers: { ...NO_STORE, "content-type": "image/jpeg", "x-live-seq": String(frame.meta.seq) },
  });
}
