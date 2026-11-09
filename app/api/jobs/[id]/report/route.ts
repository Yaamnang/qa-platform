import { type NextRequest } from "next/server";
import { bug } from "@/lib/server/bugs";
import { toCsv } from "@/lib/server/csv";
import { getJob, jobView } from "@/lib/server/data-store";
import { jsonError, requireAuth } from "@/lib/server/http";

// Download the finished report as CSV (default) or JSON.
export async function GET(req: NextRequest, ctx: RouteContext<"/api/jobs/[id]/report">) {
  const { auth, denied } = await requireAuth(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const job = await getJob(auth.tenant.id, id);
  if (!job) return jsonError(404, "Job not found.");
  const view = jobView(job);
  if (view.status !== "succeeded" || !view.report) {
    return jsonError(409, "The report is not ready yet.");
  }

  const base = job.documentName.replace(/\.csv$/i, "");
  const format = req.nextUrl.searchParams.get("format") === "json" ? "json" : "csv";

  if (format === "json") {
    return new Response(JSON.stringify({ jobId: job.id, document: job.documentName, ...view.report }, null, 2), {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="${base}-report.json"`,
      },
    });
  }

  let rows: (string | number)[][] = view.report.findings.map((f) => [
    f.metric,
    f.label,
    f.value,
    f.count ?? "",
  ]);
  if (bug("download-mismatch")) rows = rows.slice(0, -1);
  const csv = toCsv([["metric", "label", "value", "count"], ...rows]);
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${base}-report.csv"`,
    },
  });
}
