import { type NextRequest } from "next/server";
import { NO_STORE, jsonError, requireEmployee } from "@/lib/console/server/http";
import { getJob, getJobImage } from "@/lib/console/server/store";

// One problem image of a finished Probe job, from the store, opened from "Image N" on a problem card.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; n: string }> }) {
  const { denied } = await requireEmployee(req);
  if (denied) return denied;
  const { id, n } = await ctx.params;
  const job = await getJob(id);
  if (!job) return jsonError(404, "Job not found.");
  const number = /^\d{1,3}$/.test(n) ? Number(n) : NaN;
  // Only an image one of the job's problems names.
  const named = job.kind === "qa" && !!job.result?.problems.some((p) => p.image === number);
  const image = named ? await getJobImage(job.id, number) : null;
  if (!image) return jsonError(404, "This image was not saved.");
  return new Response(new Uint8Array(image.bytes), {
    headers: {
      ...NO_STORE,
      "content-type": image.mime,
      "content-disposition": `inline; filename="image-${number}.${image.mime === "image/png" ? "png" : "jpg"}"`,
      "x-content-type-options": "nosniff",
    },
  });
}
