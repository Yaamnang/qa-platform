import { NextResponse, type NextRequest } from "next/server";
import { NO_STORE, jsonError, requireEmployee } from "@/lib/console/server/http";
import { toJobDto, toProjectDto } from "@/lib/console/server/projects";
import { recoverInterruptedJobs } from "@/lib/console/server/runner";
import { getProject, listJobs } from "@/lib/console/server/store";

// One project and its jobs, newest first.
export async function GET(req: NextRequest, ctx: RouteContext<"/api/console/projects/[id]">) {
  const { denied } = await requireEmployee(req);
  if (denied) return denied;
  await recoverInterruptedJobs();
  const { id } = await ctx.params;
  const project = await getProject(id);
  if (!project) return jsonError(404, "Project not found.");
  const jobs = await listJobs(project.id);
  return NextResponse.json({ project: toProjectDto(project), jobs: jobs.map(toJobDto) }, { headers: NO_STORE });
}
