import { NextResponse, type NextRequest } from "next/server";
import { encryptSecret } from "@/lib/console/server/encryption";
import { checkToken, toGithubLinkDto } from "@/lib/console/server/github";
import { githubFailure, jsonError, requireEmployee } from "@/lib/console/server/http";
import { getProject, patchGithubLink } from "@/lib/console/server/store";

type Ctx = { params: Promise<{ id: string }> };

// Connect GitHub by pasting a personal access token (scope "repo").
// GitHub is asked whether it accepts the token before anything is stored.
// The token is stored encrypted and never logged or sent back.
export async function PUT(req: NextRequest, ctx: Ctx) {
  const { denied } = await requireEmployee(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!(await getProject(id))) return jsonError(404, "Project not found.");

  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  // GitHub tokens are short and have no spaces. Checked here so nothing odd is ever sent in a header.
  if (!token || token.length > 255 || /\s/.test(token)) return jsonError(422, "Paste a GitHub token.");

  try {
    const checked = await checkToken(token);
    if ("refused" in checked) return jsonError(422, checked.refused);
    // A new token may belong to someone else, so the cached ETag goes with the old one.
    const saved = await patchGithubLink(id, { tokenEnc: encryptSecret(token), account: checked.login, etag: null });
    return NextResponse.json({ github: toGithubLinkDto(saved) });
  } catch (err) {
    return githubFailure(err);
  }
}
