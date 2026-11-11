import { NextResponse, type NextRequest } from "next/server";
import { employeeMessage, steeringRefusal, withLiveChat } from "@/lib/console/server/chat";
import { jsonError, requireEmployee } from "@/lib/console/server/http";
import { toJobDto } from "@/lib/console/server/projects";
import { getJob } from "@/lib/console/server/store";

// A steering message from the employee while the job runs. It shows in the
// chat, and the explorer reads it before its next step. Redacted before it is
// stored, so a secret typed here by mistake is still cut out.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { denied } = await requireEmployee(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const job = await getJob(id);
  if (!job) return jsonError(404, "Job not found.");

  const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return jsonError(400, "Write a message first.");
  const refusal = steeringRefusal(job.id);
  if (refusal) return jsonError(409, refusal);
  if (!employeeMessage(job.id, text)) return jsonError(409, "This job is no longer running.");

  return NextResponse.json({ job: toJobDto(withLiveChat(job)) });
}
