import { type NextRequest } from "next/server";
import { renderApprovedDraft } from "@/lib/console/server/draft";
import { NO_STORE, jsonError, requireEmployee } from "@/lib/console/server/http";
import { getJob, getProject } from "@/lib/console/server/store";

// A Playwright draft spec of the approved proposals only, every test skipped
// with a TODO. Plain text: the page can show it, and a link downloads it.
export async function GET(req: NextRequest, ctx: RouteContext<"/api/console/jobs/[id]/draft">) {
  const { denied } = await requireEmployee(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const job = await getJob(id);
  if (!job) return jsonError(404, "Job not found.");
  if (job.kind !== "explore" || !job.proposals) {
    return jsonError(409, "Only a finished explore job has proposals to draft.");
  }
  if (job.approvedProposalIds.length === 0) {
    return jsonError(409, "No proposal is approved yet. Approve at least one to get a draft.");
  }
  const project = await getProject(job.projectId);
  if (!project) return jsonError(404, "Project not found.");

  const draft = renderApprovedDraft(job, project);
  return new Response(draft.text, {
    headers: {
      ...NO_STORE,
      "content-type": "text/plain; charset=utf-8",
      // The emitter's own file name (letters, digits, dots and dashes only),
      // saved as .txt: it is a draft to read and finish, not a test to run.
      "content-disposition": `attachment; filename="${draft.fileName.replace(/\.ts$/, "")}.txt"`,
    },
  });
}
