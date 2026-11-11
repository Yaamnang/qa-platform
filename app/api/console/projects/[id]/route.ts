import { NextResponse, type NextRequest } from "next/server";
import { NO_STORE, jsonError, requireEmployee } from "@/lib/console/server/http";
import { toJobDto, toProjectDto } from "@/lib/console/server/projects";
import { recoverInterruptedJobs } from "@/lib/console/server/runner";
import { getProject, listJobs, listUnfinishedJobs, setProjectFullAccess } from "@/lib/console/server/store";

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

// The old stored "Full access" switch. Kept so nothing that calls it breaks,
// but no page uses it and no run reads it: access is now chosen per run by the
// Probe tab's buttons (POST /projects/:id/jobs { access }). Still locked while
// a run on this workspace is active.
export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/console/projects/[id]">) {
  const { employee, denied } = await requireEmployee(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const project = await getProject(id);
  if (!project) return jsonError(404, "Project not found.");

  const body = (await req.json().catch(() => null)) as { fullAccess?: unknown } | null;
  if (typeof body?.fullAccess !== "boolean") return jsonError(400, "Send fullAccess as true or false.");

  await recoverInterruptedJobs();
  if ((await listUnfinishedJobs()).some((job) => job.projectId === project.id)) {
    return jsonError(409, "A run is in progress. Full access can be changed once it has finished.");
  }

  try {
    await setProjectFullAccess(project.id, body.fullAccess);
  } catch (err) {
    // On Supabase before db/schema-console.sql has added the column. The message says what to run.
    return jsonError(500, err instanceof Error ? err.message : "Could not save Full access.");
  }
  // Who changed it is kept in the server log.
  console.info(`[console] ${employee.email} turned Full access ${body.fullAccess ? "on" : "off"} for ${project.targetUrl}`);
  return NextResponse.json({ project: toProjectDto({ ...project, fullAccess: body.fullAccess }) }, { headers: NO_STORE });
}
