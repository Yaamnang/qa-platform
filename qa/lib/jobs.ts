import type { Page, TestInfo } from "@playwright/test";
import { config } from "./config";

/**
 * Follow a long-running AI job on screen until it finishes.
 *
 * A plain "wait up to N minutes for 'Complete'" is both slow to fail and
 * vague. Instead we watch what the user sees (stage, progress bar, status)
 * and fail early with a specific reason:
 *   - stalled: nothing on screen changed for jobStallMs
 *   - went backwards: progress decreased
 *   - failed: the job reported an error
 *   - page broke: the status disappeared (e.g. the page crashed)
 *   - timeout: no result within jobTimeoutMs
 * The observed timeline is attached to the report as evidence.
 */

export type JobSample = { atMs: number; stage: string; progress: number; status: string };

export class JobProblem extends Error {}

export async function followJob(
  page: Page,
  testInfo: TestInfo,
  opts: { timeoutMs?: number; stallMs?: number; pollMs?: number } = {},
): Promise<JobSample[]> {
  const timeoutMs = opts.timeoutMs ?? config.jobTimeoutMs;
  const stallMs = opts.stallMs ?? config.jobStallMs;
  const pollMs = opts.pollMs ?? 250;

  const bar = page.getByRole("progressbar", { name: "Analysis progress" });
  const statusEl = page.getByTestId("job-status");
  const stageEl = page.getByRole("list", { name: "Analysis stages" }).locator('[aria-current="step"]');

  const timeline: JobSample[] = [];
  const start = Date.now();
  let lastChange = start;
  let missingSince: number | null = null;

  const attach = () =>
    testInfo.attach("job-timeline.json", { body: JSON.stringify(timeline, null, 2), contentType: "application/json" });

  try {
    for (;;) {
      const now = Date.now();
      const status = await statusEl.textContent({ timeout: 1000 }).catch(() => null);

      if (status === null) {
        missingSince ??= now;
        if (now - missingSince > 3000) {
          throw new JobProblem(
            "The analysis page stopped showing job status (the page may have crashed or navigated away).",
          );
        }
      } else {
        missingSince = null;
        const progress = Number(await bar.getAttribute("aria-valuenow", { timeout: 1000 }).catch(() => NaN));
        const stage = ((await stageEl.textContent({ timeout: 500 }).catch(() => null)) ?? "").trim() || "?";
        const prev = timeline.at(-1);

        if (!prev || prev.stage !== stage || prev.progress !== progress || prev.status !== status) {
          if (prev && progress < prev.progress) {
            throw new JobProblem(`Progress went backwards from ${prev.progress}% to ${progress}% (stage "${stage}").`);
          }
          timeline.push({ atMs: now - start, stage, progress, status });
          lastChange = now;
        }

        if (status.includes("Analysis complete")) return timeline;
        if (status.includes("Analysis failed")) {
          const reason = await page.getByRole("main").getByRole("alert").first().innerText({ timeout: 1000 }).catch(() => "(no message shown)");
          throw new JobProblem(`The job reported failure to the user: "${reason.trim()}"`);
        }
        if (now - lastChange > stallMs) {
          throw new JobProblem(
            `The job appears stuck: stage "${stage}" at ${progress}% with no visible change for ${Math.round(stallMs / 1000)}s ` +
              `(${Math.round((now - start) / 1000)}s since start).`,
          );
        }
      }
      if (now - start > timeoutMs) {
        throw new JobProblem(`The job did not finish within ${Math.round(timeoutMs / 1000)}s.`);
      }
      await page.waitForTimeout(pollMs);
    }
  } finally {
    await attach();
  }
}
