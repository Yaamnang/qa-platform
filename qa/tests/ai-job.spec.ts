import { readFileSync } from "node:fs";
import { judgeSummary, summaryHygieneProblems, unsupportedNumbers, type Facts } from "../lib/ai-checks";
import { followJob } from "../lib/jobs";
import { expect, fixture, qaName, readFindings, test } from "../lib/test";

const facts: Facts = JSON.parse(readFileSync("qa/fixtures/adverse-events-24.expected.json", "utf8"));

/** What each metric must show, derived from the hand-checked facts of our synthetic file. */
const EXPECTED: Record<string, { label: string; text: string }> = {
  total_events: { label: "Adverse events recorded", text: `${facts.total_events}` },
  unique_subjects: { label: "Subjects with at least one event", text: `${facts.unique_subjects}` },
  events_treatment: { label: "Events in treatment arm", text: `${facts.events_treatment}` },
  events_placebo: { label: "Events in placebo arm", text: `${facts.events_placebo}` },
  severe_events: { label: "Severe events", text: `${facts.severe_events}` },
  most_common_event: {
    label: "Most common adverse event",
    text: `${facts.most_common_event.value} (${facts.most_common_event.count} reports)`,
  },
};

/** How a finding is displayed on screen, rebuilt from a downloaded value + count. */
const asDisplayed = (value: string, count?: string | number | null) =>
  count !== undefined && count !== null && count !== "" ? `${value} (${count} reports)` : value;

test.describe("AI analysis jobs", { tag: ["@ai-jobs", "@costly"] }, () => {
  test("an analysis runs to completion and everything it reports is true", async ({ page, qaApi }, testInfo) => {
    // A long AI job plus downloads: allow more than the default test time.
    test.setTimeout(testInfo.timeout + 120_000);
    const doc = await qaApi.seedDocument(qaName("analysis"), fixture("adverse-events-24.csv"));

    await test.step("Start an analysis from the documents list", async () => {
      await page.goto("/workspace");
      await page.getByRole("button", { name: `Analyze ${doc.name}` }).click();
      await expect(page, "Clicking Analyze should open the analysis page").toHaveURL(/\/jobs\/job_\w+$/);
      await expect(page.getByRole("heading", { name: `Analysis: ${doc.name}` })).toBeVisible();
    });

    await test.step("Follow the job until it finishes", async () => {
      const timeline = await followJob(page, testInfo);
      const stages = [...new Set(timeline.map((s) => s.stage))];
      expect(stages.at(-1), "The final stage should be 'Complete'").toBe("Complete");
    });

    let onScreen: Record<string, string> = {};
    await test.step("Check every reported number against the source file", async () => {
      await expect(page.getByRole("region", { name: "Findings" })).toBeVisible();
      onScreen = await readFindings(page);
      expect(Object.keys(onScreen).sort(), "The report should contain exactly one row per expected metric").toEqual(
        Object.keys(EXPECTED).sort(),
      );
      for (const [metric, exp] of Object.entries(EXPECTED)) {
        expect.soft(onScreen[metric], `"${exp.label}" should be ${exp.text} (true value in the uploaded file)`).toBe(exp.text);
      }
    });

    await test.step("Check the AI summary", async () => {
      const summary = (await page.getByTestId("ai-summary").innerText()).trim();
      const problems = summaryHygieneProblems(summary);
      expect(problems, `The AI summary is unusable: ${problems.join("; ")}`).toEqual([]);

      // Soft signals: recorded as warnings, never fail the build on their own.
      const note = page.getByTestId("ai-note");
      if (await note.count()) {
        testInfo.annotations.push({ type: "warning", description: `Platform note on the AI result: ${(await note.innerText()).trim()}` });
      }
      const extra = unsupportedNumbers(summary, facts);
      if (extra.length) {
        testInfo.annotations.push({ type: "warning", description: `AI summary mentions numbers not in the findings: ${extra.join(", ")}` });
      }
      const verdict = await judgeSummary(summary, facts).catch((e) => {
        testInfo.annotations.push({ type: "warning", description: `AI judge unavailable: ${(e as Error).message}` });
        return null;
      });
      if (verdict) {
        testInfo.annotations.push({
          type: verdict.faithful ? "info" : "warning",
          description: `AI judge (${verdict.source}): ${verdict.faithful ? "summary is faithful" : "possible unsupported claims: " + verdict.unsupported_claims.join("; ")}. ${verdict.explanation}`,
        });
      }
    });

    await test.step("Download the CSV report and compare it with the screen", async () => {
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("link", { name: "Download CSV report" }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename(), "Report file name should match the document").toBe(doc.name.replace(/\.csv$/, "-report.csv"));
      const text = readFileSync((await download.path())!, "utf8");
      const [header, ...lines] = text.trim().split(/\r?\n/);
      expect(header, "CSV report header").toBe("metric,label,value,count");
      const fileRows = Object.fromEntries(lines.map((l) => { const [m, , v, c] = l.split(","); return [m, { v, c }]; }));
      // Truth was checked on screen above; here the file must match what the user saw.
      for (const [metric, shown] of Object.entries(onScreen)) {
        const label = EXPECTED[metric]?.label ?? metric;
        expect.soft(fileRows[metric], `Downloaded CSV is missing "${label}", which is shown on screen`).toBeDefined();
        if (fileRows[metric]) {
          expect.soft(asDisplayed(fileRows[metric].v, fileRows[metric].c), `Downloaded CSV value for "${label}" should match the screen`).toBe(shown);
        }
      }
    });

    await test.step("Download the JSON report and compare it with the screen", async () => {
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("link", { name: "Download JSON" }).click();
      const report = JSON.parse(readFileSync((await (await downloadPromise).path())!, "utf8"));
      const byMetric = Object.fromEntries(
        (report.findings as { metric: string; value: string; count?: number }[]).map((f) => [f.metric, asDisplayed(f.value, f.count)]),
      );
      expect(byMetric, "JSON report findings should match what the user saw").toEqual(onScreen);
    });
  });
});
