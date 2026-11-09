import { NextResponse, type NextRequest } from "next/server";
import type { JobKind } from "@/lib/console/contract";
import { callbackBaseFor, jsonError, requireEmployee } from "@/lib/console/server/http";
import { toJobDto } from "@/lib/console/server/projects";
import { startProjectJob } from "@/lib/console/server/start";
import { getProject } from "@/lib/console/server/store";

const KINDS: JobKind[] = ["explore", "qa"];

// Start a job on a project: explore (read-only, proposes checks) or qa (the full runner).
// Answers 202 as soon as the child process is running; the page polls GET /api/console/jobs/:id.
// A workspace without saved credentials may start: the run asks for them in the job's chat.
// The allow-list (403) and one-at-a-time (409) checks live in
// startProjectJob, shared with the GitHub trigger route.
export async function POST(req: NextRequest, ctx: RouteContext<"/api/console/projects/[id]/jobs">) {
  const { employee, denied } = await requireEmployee(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as { kind?: unknown } | null;
  const kind = KINDS.find((k) => k === body?.kind);
  if (!kind) return jsonError(400, 'Choose what to run: "explore" or "qa".');

  const { id } = await ctx.params;
  const project = await getProject(id);
  if (!project) return jsonError(404, "Project not found.");

  const outcome = await startProjectJob(project, kind, employee.email, undefined, callbackBaseFor(req));
  if ("error" in outcome) return jsonError(outcome.status, outcome.error);
  return NextResponse.json({ job: toJobDto(outcome.job) }, { status: 202 });
}
