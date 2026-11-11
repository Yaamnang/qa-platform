import { JOB_KIND_LABEL, type Job, type TriageItem } from "./contract";

/**
 * The "Fixes needed" list of a finished job, and its Markdown. Shared by the
 * panel on the page (its Copy button) and the downloaded report, so both say
 * the same thing. No React here, so a route handler can use it too.
 */

/** One thing to fix. nextStep is left out when nothing says what to do. */
export type Fix = { category: TriageItem["category"]; point: string; evidence: string; nextStep?: string };

export const FIX_CATEGORY_LABEL: Record<Fix["category"], string> = {
  product: "Product",
  test: "Test",
  environment: "Environment",
};

/**
 * The summary's triage when it has any (advisory, possibly written by Claude).
 * Otherwise the run's own problems, so a failed run never shows an empty list,
 * or the error of a run that stopped.
 */
export function fixesFor(job: Job): { items: Fix[]; fromTriage: boolean; byClaude: boolean } {
  const triage = job.summary?.triage ?? [];
  if (triage.length > 0) return { items: triage, fromTriage: true, byClaude: job.summary?.by === "claude" };

  const problems = job.result?.problems ?? [];
  if (problems.length > 0) {
    const items = problems.map((p): Fix => ({
      category: "product",
      point: p.headline,
      evidence: [p.failedStep ? `Failing step: ${p.failedStep}` : null, ...p.details].filter(Boolean).join("\n"),
    }));
    return { items, fromTriage: false, byClaude: false };
  }

  if (job.status === "error") {
    const items: Fix[] = [{ category: "environment", point: "The run stopped before it could judge the product.", evidence: job.error ?? "No reason was given." }];
    return { items, fromTriage: false, byClaude: false };
  }
  return { items: [], fromTriage: false, byClaude: false };
}

/** The list as Markdown, to paste into an issue or a pull request. */
export function fixesMarkdown(job: Job, items: Fix[], byClaude: boolean): string {
  const lines = [`## Fixes needed: ${JOB_KIND_LABEL[job.kind]} ${job.status}, job ${job.id}`, ""];
  if (byClaude) lines.push("Sorted by Claude, advisory.", "");
  items.forEach((item, i) => {
    lines.push(`${i + 1}. **${FIX_CATEGORY_LABEL[item.category]}:** ${item.point}`);
    if (item.evidence) {
      const fence = item.evidence.includes("```") ? "````" : "```";
      lines.push("", `   ${fence}`, ...item.evidence.split("\n").map((l) => `   ${l}`), `   ${fence}`);
    }
    if (item.nextStep) lines.push("", `   Next step: ${item.nextStep}`);
    lines.push("");
  });
  return lines.join("\n").trimEnd() + "\n";
}
