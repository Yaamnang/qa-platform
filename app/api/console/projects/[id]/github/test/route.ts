import { NextResponse, type NextRequest } from "next/server";
import { GITHUB_NOT_CONNECTED } from "@/lib/console/contract";
import { decryptSecret } from "@/lib/console/server/encryption";
import { parseRepoUrl, repoAccess } from "@/lib/console/server/github";
import { testCommit } from "@/lib/console/server/github-poller";
import { githubFailure, jsonError, requireEmployee } from "@/lib/console/server/http";
import { toJobDto } from "@/lib/console/server/projects";
import { getGithubLink, getProject } from "@/lib/console/server/store";

type Ctx = { params: Promise<{ id: string }> };

// The GitHub code test on the Probe tab. Takes a repository link, checks that
// the workspace's GitHub account can push to it (a collaborator with write
// access), and starts a Probe for the newest commit on its default branch,
// with commit statuses as for a watched branch. The watched repo and branch
// do not change. Read-only unless the host is on the allow-list.
export async function POST(req: NextRequest, ctx: Ctx) {
  const { employee, denied } = await requireEmployee(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!(await getProject(id))) return jsonError(404, "Project not found.");

  const link = await getGithubLink(id);
  if (!link?.tokenEnc) return jsonError(409, GITHUB_NOT_CONNECTED);

  const body = (await req.json().catch(() => null)) as { repoUrl?: unknown } | null;
  const repo = typeof body?.repoUrl === "string" ? parseRepoUrl(body.repoUrl) : null;
  if (!repo) return jsonError(400, "Enter a GitHub repository link, for example https://github.com/owner/repo.");

  try {
    const access = await repoAccess(decryptSecret(link.tokenEnc), repo);
    if ("denied" in access) return jsonError(403, `You are not a collaborator on ${repo}.`);
    const outcome = await testCommit(id, access.fullName, access.defaultBranch, employee.email);
    if ("error" in outcome) return jsonError(outcome.status, outcome.error);
    console.info(`[console] ${employee.email} started a GitHub code test (${outcome.job.id}) for ${access.fullName}`);
    return NextResponse.json({ job: toJobDto(outcome.job) }, { status: 202 });
  } catch (err) {
    return githubFailure(err);
  }
}
