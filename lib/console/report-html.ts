import { JOB_KIND_LABEL, type Job } from "./contract";
import { fixesFor, fixesMarkdown } from "./fixes";

/**
 * The downloadable Probe report: one HTML file that needs nothing else. Images
 * are embedded as data: URIs, there are no scripts and no external resources,
 * and every piece of text is escaped. Pure: the route reads the job and the
 * image files and passes them in.
 *
 * images: problem image number to its data: URI, or null when it was not
 * saved in the store. A problem whose number is missing from the map has no image.
 */

export type ReportInput = {
  job: Job;
  project: { name: string; targetUrl: string };
  images: Map<number, string | null>;
};

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const when = (ms: number | null) => (ms ? `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC` : "not recorded");

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

const VERDICT_CLASS: Record<string, string> = { PASS: "pass", FAIL: "fail", ERROR: "warn" };

const STYLE = `
body { font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1f2328; max-width: 960px; margin: 32px auto; padding: 0 20px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 17px; margin: 32px 0 12px; border-bottom: 1px solid #d0d7de; padding-bottom: 4px; }
h3 { font-size: 15px; margin: 0 0 6px; }
.meta { color: #57606a; margin: 2px 0; }
.verdict { font-size: 28px; font-weight: 600; margin: 16px 0 4px; }
.pass { color: #1a7f37; } .fail { color: #cf222e; } .warn { color: #9a6700; }
table.counts { border-collapse: collapse; margin: 8px 0; }
table.counts td { border: 1px solid #d0d7de; padding: 4px 12px; }
.mono, pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.problem { border: 1px solid #d0d7de; border-radius: 8px; padding: 14px 16px; margin: 0 0 16px; break-inside: avoid; }
.label { color: #57606a; }
ul { margin: 6px 0; padding-left: 20px; }
figure { margin: 12px 0 0; }
figure img { max-width: 100%; border: 1px solid #d0d7de; }
figcaption { color: #57606a; font-size: 12px; margin-top: 4px; }
.note { color: #57606a; font-style: italic; margin-top: 8px; }
pre { background: #f6f8fa; padding: 10px 12px; white-space: pre-wrap; word-break: break-word; border-radius: 6px; }
@media print { body { margin: 0; } pre { break-inside: auto; } }
`;

export function reportFileName(jobId: string): string {
  return `probe-report-${jobId.replace(/[^A-Za-z0-9_-]/g, "")}.html`;
}

export function buildReportHtml({ job, project, images }: ReportInput): string {
  const r = job.result;
  const out: string[] = [];
  const e = escapeHtml;
  const title = `${JOB_KIND_LABEL[job.kind]} report: ${project.name}`;

  out.push(
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${e(title)}</title><style>${STYLE}</style></head><body>`,
    `<h1>${e(title)}</h1>`,
    `<p class="meta">Target: <span class="mono">${e(project.targetUrl)}</span></p>`,
    `<p class="meta">Job <span class="mono">${e(job.id)}</span>${r?.runId ? `, run <span class="mono">${e(r.runId)}</span>` : ""}, started by ${e(job.createdBy)}</p>`,
    `<p class="meta">Started ${e(when(job.startedAt))}, finished ${e(when(job.finishedAt))}</p>`,
  );

  if (r) {
    out.push(
      `<p class="verdict ${VERDICT_CLASS[r.verdict] ?? "warn"}">${e(r.verdict)}</p>`,
      '<table class="counts"><tr>',
      `<td>Passed <b>${r.passed}</b></td><td>Failed <b>${r.failed}</b></td><td>Flaky <b>${r.flaky}</b></td><td>Not run <b>${r.skipped}</b></td><td>Duration <b>${e(seconds(r.durationMs))}</b></td>`,
      "</tr></table>",
    );
  } else {
    out.push('<p class="verdict warn">No result</p>');
  }
  if (job.error) out.push(`<p><span class="label">Error:</span> ${e(job.error)}</p>`);

  const problems = r?.problems ?? [];
  if (problems.length > 0) {
    out.push(`<h2>Problems (${problems.length})</h2>`);
    problems.forEach((p, i) => {
      out.push('<section class="problem">', `<h3>${i + 1}. ${e(p.headline)}</h3>`);
      out.push(`<p><span class="label">Area:</span> ${e(p.area)} <span class="label">Severity:</span> ${e(p.severity)}</p>`);
      if (p.failedStep) out.push(`<p><span class="label">Failing step:</span> ${e(p.failedStep)}</p>`);
      if (p.details.length) out.push(`<ul class="mono">${p.details.map((d) => `<li>${e(d)}</li>`).join("")}</ul>`);
      if (p.tests.length) out.push(`<p><span class="label">Affected:</span> ${p.tests.map(e).join("; ")}</p>`);
      if (p.image) {
        const uri = images.get(p.image);
        out.push(
          uri
            ? `<figure><img src="${e(uri)}" alt="Image ${p.image}"><figcaption>Image ${p.image}</figcaption></figure>`
            : `<p class="note">Image ${p.image} was not saved.</p>`,
        );
      } else if (p.imageNote) {
        out.push(`<p class="note">${e(p.imageNote)}</p>`);
      }
      out.push("</section>");
    });
  }

  const { items, byClaude } = fixesFor(job);
  if (items.length > 0) {
    out.push(`<h2>Fixes needed (${items.length})</h2>`);
    out.push(`<pre>${e(fixesMarkdown(job, items, byClaude))}</pre>`);
  }

  out.push("<h2>Log</h2>", `<pre>${e(job.logTail || "(empty)")}</pre>`, "</body></html>");
  return out.join("\n");
}
