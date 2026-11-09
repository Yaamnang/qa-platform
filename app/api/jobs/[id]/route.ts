import { NextResponse, type NextRequest } from "next/server";
import { getJob, jobView } from "@/lib/server/data-store";
import { jsonError, requireAuth } from "@/lib/server/http";

export async function GET(req: NextRequest, ctx: RouteContext<"/api/jobs/[id]">) {
  const { auth, denied } = await requireAuth(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const job = await getJob(auth.tenant.id, id);
  if (!job) return jsonError(404, "Job not found.");
  return NextResponse.json({ job: jobView(job) }, { headers: { "cache-control": "no-store" } });
}
