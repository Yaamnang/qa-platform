import { NextResponse, type NextRequest } from "next/server";
import type { Job, Project } from "@/lib/console/contract";
import { ConsoleKeyError, encryptSecret } from "@/lib/console/server/encryption";
import { NO_STORE, jsonError, requireEmployee } from "@/lib/console/server/http";
import { normalizeTotpSecret, parseTargetUrl, toJobDto, toProjectDto } from "@/lib/console/server/projects";
import { recoverInterruptedJobs } from "@/lib/console/server/runner";
import { createProject, lastJob, listProjects } from "@/lib/console/server/store";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Every project, newest first, each with its most recent job for the status column.
export async function GET(req: NextRequest) {
  const { denied } = await requireEmployee(req);
  if (denied) return denied;
  await recoverInterruptedJobs();

  // One query per project for its last job. Plain and fine for the handful of
  // projects one QA team has; a join would be the next step if that grows.
  const projects = await listProjects();
  const rows: Array<Project & { lastJob: Job | null }> = await Promise.all(
    projects.map(async (project) => {
      const job = await lastJob(project.id);
      return { ...toProjectDto(project), lastJob: job ? toJobDto(job) : null };
    }),
  );
  return NextResponse.json({ projects: rows }, { headers: NO_STORE });
}

// Add a project: a target, and the QA account the runner signs in with there.
export async function POST(req: NextRequest) {
  const { employee, denied } = await requireEmployee(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const text = (key: string) => (typeof body?.[key] === "string" ? (body[key] as string) : "");
  const name = text("name").trim();
  const qaEmail = text("qaEmail").trim();
  const qaPassword = text("qaPassword");
  const rawTotpSecret = text("qaTotpSecret").trim();

  const fieldErrors: Record<string, string> = {};
  if (name.length < 1 || name.length > 80) fieldErrors.name = "Enter a project name (up to 80 characters).";
  const target = parseTargetUrl(text("targetUrl"));
  if ("error" in target) fieldErrors.targetUrl = target.error;
  if (qaEmail && !EMAIL.test(qaEmail)) fieldErrors.qaEmail = "Enter the QA account's email address.";

  // Every QA account field is optional. A run started by hand asks for what is
  // missing in the job's chat when it reaches the sign-in screen. A
  // GitHub-triggered run needs both the password and the TOTP secret
  // (hasCredentials), because nobody is there to answer.
  const qaTotpSecret = rawTotpSecret ? normalizeTotpSecret(rawTotpSecret) : "";
  if (qaPassword && !qaEmail) fieldErrors.qaEmail = "Enter the email that goes with this password.";
  if (rawTotpSecret && qaTotpSecret === null) {
    fieldErrors.qaTotpSecret = "That is not a valid TOTP secret. Paste the base32 key the authenticator setup shows.";
  }

  if (Object.keys(fieldErrors).length || "error" in target) {
    // error is a full sentence on its own, for a page that shows only that;
    // fieldErrors lets a form put each message under its field.
    return NextResponse.json({ error: Object.values(fieldErrors)[0], fieldErrors }, { status: 422 });
  }

  let qaPasswordEnc: string | null = null;
  let qaTotpSecretEnc: string | null = null;
  if (qaPassword || qaTotpSecret) {
    try {
      if (qaPassword) qaPasswordEnc = encryptSecret(qaPassword);
      if (qaTotpSecret) qaTotpSecretEnc = encryptSecret(qaTotpSecret);
    } catch (err) {
      // A missing or malformed CONSOLE_SECRET_KEY: say so, rather than store the secrets in the clear.
      if (err instanceof ConsoleKeyError) return jsonError(500, err.message);
      throw err;
    }
  }

  const project = await createProject({
    name,
    targetUrl: target.url,
    qaEmail,
    qaPasswordEnc,
    qaTotpSecretEnc,
    createdBy: employee.email,
  });
  return NextResponse.json({ project: toProjectDto(project) }, { status: 201 });
}
