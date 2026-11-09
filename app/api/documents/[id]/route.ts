import { NextResponse, type NextRequest } from "next/server";
import { deleteDocument, getDocument } from "@/lib/server/data-store";
import { jsonError, requireAdmin, requireAuth } from "@/lib/server/http";

export async function GET(req: NextRequest, ctx: RouteContext<"/api/documents/[id]">) {
  const { auth, denied } = await requireAuth(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const doc = await getDocument(auth.tenant.id, id);
  // 404 (not 403) for other tenants' documents so IDs can't be probed.
  if (!doc) return jsonError(404, "Document not found.");
  return NextResponse.json({
    document: { id: doc.id, name: doc.name, rows: doc.table.rows.length, uploadedAt: doc.uploadedAt },
  });
}

export async function DELETE(req: NextRequest, ctx: RouteContext<"/api/documents/[id]">) {
  const { auth, denied } = await requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!(await deleteDocument(auth.tenant.id, id))) return jsonError(404, "Document not found.");
  return NextResponse.json({ ok: true });
}
