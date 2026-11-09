import { NextResponse, type NextRequest } from "next/server";
import { createJob, getDocument, jobView, listJobs } from "@/lib/server/data-store";
import { jsonError, requireAdmin, requireAuth } from "@/lib/server/http";

export async function GET(req: NextRequest) {
  const { auth, denied } = await requireAuth(req);
  if (denied) return denied;
  const jobs = (await listJobs(auth.tenant.id)).map((j) => {
    const v = jobView(j);
    return { id: v.id, documentName: v.documentName, status: v.status, stage: v.stage, createdAt: v.createdAt };
  });
  return NextResponse.json({ jobs });
}

export async function POST(req: NextRequest) {
  const { auth, denied } = await requireAdmin(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { documentId?: string } | null;
  const doc = body?.documentId ? await getDocument(auth.tenant.id, body.documentId) : undefined;
  if (!doc) return jsonError(404, "Document not found.");
  const job = await createJob(auth.tenant.id, doc);
  return NextResponse.json({ job: { id: job.id } }, { status: 202 });
}
