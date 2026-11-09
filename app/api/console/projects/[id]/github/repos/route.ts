import { NextResponse, type NextRequest } from "next/server";
import { decryptSecret } from "@/lib/console/server/encryption";
import { listRepos } from "@/lib/console/server/github";
import { NO_STORE, githubFailure, jsonError, requireEmployee } from "@/lib/console/server/http";
import { getGithubLink, getProject } from "@/lib/console/server/store";

type Ctx = { params: Promise<{ id: string }> };

// The repos the connected token can see, up to 200, most recently pushed first, for the repo picker.
export async function GET(req: NextRequest, ctx: Ctx) {
  const { denied } = await requireEmployee(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!(await getProject(id))) return jsonError(404, "Project not found.");

  const link = await getGithubLink(id);
  if (!link?.tokenEnc) return jsonError(409, "Connect GitHub first: paste a token.");
  try {
    return NextResponse.json({ repos: await listRepos(decryptSecret(link.tokenEnc)) }, { headers: NO_STORE });
  } catch (err) {
    return githubFailure(err);
  }
}
