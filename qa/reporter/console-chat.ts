import type { Reporter, TestCase, TestResult, TestStep } from "@playwright/test/reporter";
import { say } from "../lib/console-link";

/**
 * Short notes for the QA console's job chat at the journey boundaries a
 * person cares about. Only added to the reporters when the run was started by
 * the console (playwright.config.ts). It reads step titles and results; it
 * never touches a test, an assertion or the verdict.
 */
const STEP_NOTES: Array<{ title: RegExp; text: string; event: string }> = [
  { title: /^Choose a CSV file and click Upload$/, text: "Uploading the test file.", event: "upload" },
  { title: /^Follow the job until it finishes$/, text: "Analysis started, following it until it finishes.", event: "analysis-started" },
  { title: /^Check every reported number against the source file$/, text: "Analysis finished, checking the numbers.", event: "analysis-finished" },
];

export default class ConsoleChatReporter implements Reporter {
  private said = new Set<string>();
  private pending: Promise<void>[] = [];

  private note(text: string, event: string) {
    if (this.said.has(event)) return;
    this.said.add(event);
    this.pending.push(say(text, event));
  }

  onStepBegin(_test: TestCase, _result: TestResult, step: TestStep) {
    if (step.category !== "test.step") return;
    const match = STEP_NOTES.find((n) => n.title.test(step.title));
    if (match) this.note(match.text, match.event);
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const project = test.parent.project()?.name;
    if (project === "setup" && result.status === "passed") {
      this.note("Signed in and checked the bot is inside its own test organization.", "signed-in");
    }
    if (result.status === "failed" && result.retry === 0) {
      this.pending.push(say(`"${test.title}" failed. Running it once more before reporting it.`, "retry"));
    }
  }

  async onEnd() {
    await Promise.all(this.pending);
  }
}
