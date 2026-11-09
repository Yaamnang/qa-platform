import { NextResponse, type NextRequest } from "next/server";
import { missingColumns } from "@/lib/server/analysis";
import { bug } from "@/lib/server/bugs";
import { parseCsv } from "@/lib/server/csv";
import { addDocument, listDocuments } from "@/lib/server/data-store";
import { jsonError, requireAdmin, requireAuth } from "@/lib/server/http";
import type { DocumentRecord } from "@/lib/server/store-types";

const MAX_BYTES = 1024 * 1024;

function toDocumentDto(d: DocumentRecord) {
  return {
    id: d.id,
    name: d.name,
    rows: d.table.rows.length,
    sizeBytes: d.sizeBytes,
    uploadedAt: d.uploadedAt,
  };
}

export async function GET(req: NextRequest) {
  const { auth, denied } = await requireAuth(req);
  if (denied) return denied;
  if (bug("slow-documents")) await new Promise((r) => setTimeout(r, 3000)); // slow, not broken
  const documents = await listDocuments(auth.tenant.id);
  return NextResponse.json({ documents: documents.map(toDocumentDto) });
}

export async function POST(req: NextRequest) {
  // Only Admins may upload. The injected regression forgets that check.
  const { auth, denied } = await (bug("viewer-can-edit") ? requireAuth(req) : requireAdmin(req));
  if (denied) return denied;

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return jsonError(400, "Choose a file to upload.");
  }
  if (!file.name.toLowerCase().endsWith(".csv")) {
    return jsonError(415, "Only CSV files can be analysed. Please upload a .csv file.");
  }
  if (file.size > MAX_BYTES) {
    return jsonError(413, "File is larger than 1 MB.");
  }

  const table = parseCsv(await file.text());
  const missing = missingColumns(table);
  if (missing.length) {
    return jsonError(422, `The file is missing required columns: ${missing.join(", ")}.`);
  }
  if (table.rows.length === 0) {
    return jsonError(422, "The file has a header but no data rows.");
  }

  const doc = await addDocument(auth.tenant.id, auth.user.id, file.name, file.size, table);
  return NextResponse.json({ document: toDocumentDto(doc) }, { status: 201 });
}
