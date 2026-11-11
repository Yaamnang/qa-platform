import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireEmployee } from "@/lib/console/server/http";
import { stopJob } from "@/lib/console/server/runner";
import { getJob } from "@/lib/console/server/store";

// The Stop button. The job ends as "error" with "Stopped by <email>", keeping
// its log, chat and summary. Answers 202: the page sees the final state on its next poll.
export async function POST(req: NextRequest, ctx: RouteContext<"/api/console/jobs/[id]/stop">) {
  const { employee, denied } = await requireEmployee(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const job = await getJob(id);
  if (!job) return jsonError(404, "Job not found.");
  if (job.status !== "queued" && job.status !== "running" && job.status !== "waiting") {
    return jsonError(409, "This run has already finished.");
  }
  if (!stopJob(job.id, employee.email)) {
    return jsonError(409, "This run is still starting, or another console server is running it. Try again in a moment.");
  }
  console.info(`[console] ${employee.email} stopped job ${job.id}`);
  return NextResponse.json({ ok: true }, { status: 202 });
}
