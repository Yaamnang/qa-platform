import { NextResponse, type NextRequest } from "next/server";
import { answerAsk, holdRemember, openAsk, parseAnswer, systemMessage, withLiveChat } from "@/lib/console/server/chat";
import { ConsoleKeyError, encryptSecret } from "@/lib/console/server/encryption";
import { jsonError, requireEmployee } from "@/lib/console/server/http";
import { toJobDto } from "@/lib/console/server/projects";
import type { ProjectCredentialsPatch } from "@/lib/console/server/records";
import { getJob, updateProjectCredentials } from "@/lib/console/server/store";

// The employee answers a question from the run: a login, a one-time code (or
// the authenticator setup key), or free text.
//
// The values never reach the transcript, a log or the model. They are held in
// server memory until the run collects them, then dropped (chat.ts). The chat
// records only "Login provided" or "Code provided". Nothing here logs them.
//
// remember: true also saves a login or setup key on the workspace, encrypted
// like the fields on the New workspace form, for later and unattended runs.
// Only once the run reports that sign-in worked: until then the encrypted
// values wait in server memory (chat.ts holdRemember), and they are dropped
// if the job ends first, so a mistyped password is never stored.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { denied } = await requireEmployee(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const job = await getJob(id);
  if (!job) return jsonError(404, "Job not found.");

  const body = (await req.json().catch(() => null)) as { askId?: unknown; values?: unknown; remember?: unknown } | null;
  const askId = typeof body?.askId === "string" ? body.askId : "";
  const ask = openAsk(job.id, askId);
  if (!ask) return jsonError(409, "The run is no longer waiting for this answer.");

  const parsed = parseAnswer(ask.kind, body?.values);
  if ("error" in parsed) return jsonError(422, parsed.error);
  const values = parsed.values;

  // Encrypt before handing over, so a missing CONSOLE_SECRET_KEY is reported
  // and the answer still goes to the run.
  let remembered: ProjectCredentialsPatch | null = null;
  let rememberError: string | null = null;
  if (body?.remember === true && ("password" in values || "totpSecret" in values)) {
    try {
      remembered =
        "password" in values
          ? { qaEmail: values.email, qaPasswordEnc: encryptSecret(values.password) }
          : { qaTotpSecretEnc: encryptSecret(values.totpSecret) };
    } catch (err) {
      if (!(err instanceof ConsoleKeyError)) throw err;
      rememberError = err.message;
    }
  }

  if (!answerAsk(job.id, askId, values)) return jsonError(409, "The run is no longer waiting for this answer.");

  if (remembered) {
    const patch = remembered;
    const what = "password" in values ? "Login" : "Authenticator key";
    if (holdRemember(job.id, { what, save: () => updateProjectCredentials(job.projectId, patch) })) {
      systemMessage(job.id, `${what} will be saved for this workspace once sign-in works.`);
    }
  } else if (rememberError) {
    systemMessage(job.id, `Not saved for this workspace: ${rememberError}`);
  }

  return NextResponse.json({ job: toJobDto(withLiveChat(job)) });
}
