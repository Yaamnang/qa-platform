import { NextResponse, type NextRequest } from "next/server";
import type { JobAccess, JobKind } from "@/lib/console/contract";
import { callbackBaseFor, jsonError, requireEmployee } from "@/lib/console/server/http";
import { toJobDto } from "@/lib/console/server/projects";
import { startProjectJob } from "@/lib/console/server/start";
import { getProject } from "@/lib/console/server/store";

const KINDS: JobKind[] = ["explore", "qa"];
const ACCESS: JobAccess[] = ["read", "full"];

// Start a job on a project: explore (read-only, proposes checks) or qa (the Probe).
// access, for qa only: "read" (the Explore button, the default) never changes
// data, whatever the host; "full" (the Full access test button) may save,
// upload and delete. Chosen per run; the stored Full access switch is not read.
// Answers 202 as soon as the child process is running; the page polls GET /api/console/jobs/:id.
// A workspace without saved credentials may start: the run asks for them in the job's chat.
// The access (403) and one-at-a-time (409) checks live in startProjectJob,
// shared with the GitHub routes and the poller.
export async function POST(req: NextRequest, ctx: RouteContext<"/api/console/projects/[id]/jobs">) {
  const { employee, denied } = await requireEmployee(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as { kind?: unknown; access?: unknown } | null;
  const kind = KINDS.find((k) => k === body?.kind);
  if (!kind) return jsonError(400, 'Choose what to run: "explore" or "qa".');
  const access = body?.access === undefined ? "read" : ACCESS.find((a) => a === body.access);
  if (!access) return jsonError(400, 'Send access as "read" or "full".');

  const { id } = await ctx.params;
  const project = await getProject(id);
  if (!project) return jsonError(404, "Project not found.");

  const writes = kind === "qa" && access === "full";
  const outcome = await startProjectJob(project, kind, employee.email, { writes, callbackBase: callbackBaseFor(req) });
  if ("error" in outcome) return jsonError(outcome.status, outcome.error);
  // Who started a run that may change data is kept in the server log.
  if (writes) console.info(`[console] ${employee.email} started a full access Probe (${outcome.job.id}) on ${project.targetUrl}`);
  return NextResponse.json({ job: toJobDto(outcome.job) }, { status: 202 });
}
