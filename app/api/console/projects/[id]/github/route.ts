import { NextResponse, type NextRequest } from "next/server";
import { branchHead, isBranchName, isRepoName, toGithubLinkDto } from "@/lib/console/server/github";
import { decryptSecret } from "@/lib/console/server/encryption";
import { isWatched } from "@/lib/console/server/github-poller";
import { NO_STORE, githubFailure, jsonError, requireEmployee } from "@/lib/console/server/http";
import { deleteGithubLink, getGithubLink, getProject, patchGithubLink } from "@/lib/console/server/store";

type Ctx = { params: Promise<{ id: string }> };

// The workspace's GitHub connection: account, watched repo and branch, last poll. Never the token.
export async function GET(req: NextRequest, ctx: Ctx) {
  const { denied } = await requireEmployee(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!(await getProject(id))) return jsonError(404, "Project not found.");
  return NextResponse.json({ github: toGithubLinkDto(await getGithubLink(id)) }, { headers: NO_STORE });
}

// Start watching a repo and branch. The branch's current head is recorded as
// already seen, so choosing a branch does not start a run; the next push does.
export async function PUT(req: NextRequest, ctx: Ctx) {
  const { denied } = await requireEmployee(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!(await getProject(id))) return jsonError(404, "Project not found.");

  const link = await getGithubLink(id);
  if (!link?.tokenEnc) return jsonError(409, "Connect GitHub first: paste a token.");

  const body = (await req.json().catch(() => null)) as { repo?: unknown; branch?: unknown } | null;
  const repo = typeof body?.repo === "string" ? body.repo.trim() : "";
  const branch = typeof body?.branch === "string" ? body.branch.trim() : "";
  if (!isRepoName(repo)) return jsonError(422, 'Pick a repo, written as "owner/name".');
  if (!isBranchName(branch)) return jsonError(422, "Enter a valid branch name.");

  try {
    const head = await branchHead(decryptSecret(link.tokenEnc), repo, branch, null);
    if ("missing" in head) {
      return jsonError(422, `Could not find branch ${branch} in ${repo}, or this GitHub account cannot see it.`);
    }
    if (!head.changed) return jsonError(502, "GitHub gave no answer for that branch. Try again.");
    const saved = await patchGithubLink(id, {
      repo,
      branch,
      lastSeenSha: head.sha,
      lastCheckedAt: Date.now(),
      etag: head.etag,
      // A job from the previously watched repo would report to the wrong one.
      pendingJobId: null,
    });
    return NextResponse.json({ github: toGithubLinkDto(saved) });
  } catch (err) {
    return githubFailure(err);
  }
}

// The "Check every new commit" switch. Off keeps the token, repo and branch; the poller just skips them.
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { denied } = await requireEmployee(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!(await getProject(id))) return jsonError(404, "Project not found.");
  if (!isWatched(await getGithubLink(id))) return jsonError(409, "Connect GitHub and pick a repo and branch first.");

  const body = (await req.json().catch(() => null)) as { autoCheck?: unknown } | null;
  if (typeof body?.autoCheck !== "boolean") return jsonError(400, "Send autoCheck as true or false.");

  try {
    const saved = await patchGithubLink(id, { autoCheck: body.autoCheck });
    return NextResponse.json({ github: toGithubLinkDto(saved) }, { headers: NO_STORE });
  } catch (err) {
    // On Supabase before db/schema-console.sql has added the column. The message says what to run.
    return jsonError(500, err instanceof Error ? err.message : "Could not save the switch.");
  }
}

// Disconnect: the token and the watched repo are forgotten. Commit statuses
// already posted stay on GitHub; job history stays in the console.
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { denied } = await requireEmployee(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!(await getProject(id))) return jsonError(404, "Project not found.");
  await deleteGithubLink(id);
  return NextResponse.json({ github: toGithubLinkDto(undefined) });
}
