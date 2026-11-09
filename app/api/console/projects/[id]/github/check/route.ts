import { NextResponse, type NextRequest } from "next/server";
import { toGithubLinkDto } from "@/lib/console/server/github";
import { checkWorkspace, isWatched } from "@/lib/console/server/github-poller";
import { githubFailure, jsonError, requireEmployee } from "@/lib/console/server/http";
import { getGithubLink, getProject } from "@/lib/console/server/store";

type Ctx = { params: Promise<{ id: string }> };

// Poll now instead of waiting for the next tick, for demos. Exactly what the
// poller does: a new commit starts a Probe, nothing new starts nothing.
export async function POST(req: NextRequest, ctx: Ctx) {
  const { denied } = await requireEmployee(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!(await getProject(id))) return jsonError(404, "Project not found.");
  if (!isWatched(await getGithubLink(id))) return jsonError(409, "Connect GitHub and pick a repo and branch first.");

  try {
    const startedJobId = await checkWorkspace(id);
    return NextResponse.json({ github: toGithubLinkDto(await getGithubLink(id)), startedJobId });
  } catch (err) {
    return githubFailure(err);
  }
}
