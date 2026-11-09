import { NextResponse, type NextRequest } from "next/server";
import { withLiveChat } from "@/lib/console/server/chat";
import { NO_STORE, jsonError, requireEmployee } from "@/lib/console/server/http";
import { toJobDto } from "@/lib/console/server/projects";
import { recoverInterruptedJobs } from "@/lib/console/server/runner";
import { getJob } from "@/lib/console/server/store";

// One job, polled by the page while it runs: status, log tail, chat, then proposals or the QA result.
export async function GET(req: NextRequest, ctx: RouteContext<"/api/console/jobs/[id]">) {
  const { denied } = await requireEmployee(req);
  if (denied) return denied;
  await recoverInterruptedJobs();
  const { id } = await ctx.params;
  const job = await getJob(id);
  if (!job) return jsonError(404, "Job not found.");
  return NextResponse.json({ job: toJobDto(withLiveChat(job)) }, { headers: NO_STORE });
}
