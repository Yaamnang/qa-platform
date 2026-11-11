import { type NextRequest } from "next/server";
import { NO_STORE, jsonError, requireEmployee } from "@/lib/console/server/http";
import { toJobDto } from "@/lib/console/server/projects";
import { getJob, getJobImage, getProject } from "@/lib/console/server/store";
import { buildReportHtml, reportFileName } from "@/lib/console/report-html";

// The whole Probe report as one HTML file, images embedded, for the Download report button.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { denied } = await requireEmployee(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const record = await getJob(id);
  if (!record) return jsonError(404, "Job not found.");
  if (record.kind !== "qa" || !record.result) return jsonError(409, "Only a finished Probe job has a report.");
  const project = await getProject(record.projectId);
  if (!project) return jsonError(404, "Project not found.");

  const job = toJobDto(record);
  const images = new Map<number, string | null>();
  for (const p of job.result!.problems) {
    if (!p.image) continue;
    const image = await getJobImage(job.id, p.image);
    images.set(p.image, image ? `data:${image.mime};base64,${image.bytes.toString("base64")}` : null);
  }

  const html = buildReportHtml({ job, project: { name: project.name, targetUrl: project.targetUrl }, images });
  return new Response(html, {
    headers: {
      ...NO_STORE,
      "content-type": "text/html; charset=utf-8",
      "content-disposition": `attachment; filename="${reportFileName(job.id)}"`,
      "x-content-type-options": "nosniff",
    },
  });
}
