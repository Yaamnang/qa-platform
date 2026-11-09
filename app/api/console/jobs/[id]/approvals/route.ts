import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireEmployee } from "@/lib/console/server/http";
import { toJobDto } from "@/lib/console/server/projects";
import { getJob, updateJob } from "@/lib/console/server/store";

// Which of an explore job's proposals an employee approved. The list sent
// replaces the previous one, so un-approving is sending a shorter list.
export async function PUT(req: NextRequest, ctx: RouteContext<"/api/console/jobs/[id]/approvals">) {
  const { denied } = await requireEmployee(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const job = await getJob(id);
  if (!job) return jsonError(404, "Job not found.");
  if (job.kind !== "explore" || !job.proposals) {
    return jsonError(409, "Only a finished explore job has proposals to approve.");
  }

  const body = (await req.json().catch(() => null)) as { approvedProposalIds?: unknown } | null;
  const ids = body?.approvedProposalIds;
  if (!Array.isArray(ids) || !ids.every((value) => typeof value === "string")) {
    return jsonError(400, "Send approvedProposalIds as a list of proposal ids.");
  }
  const known = new Set(job.proposals.map((p) => p.id));
  const unknown = ids.filter((value) => !known.has(value));
  if (unknown.length) return jsonError(422, `This job has no proposal with the id ${unknown.join(", ")}.`);

  // Stored in the explorer's order, without duplicates, whatever order they were sent in.
  const approvedProposalIds = job.proposals.map((p) => p.id).filter((proposalId) => ids.includes(proposalId));
  await updateJob(job.id, { approvedProposalIds });
  return NextResponse.json({ job: toJobDto({ ...job, approvedProposalIds }) });
}
