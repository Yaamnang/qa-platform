import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Problem } from "../reporter/plain-report";

/**
 * Optional AI triage of failures (QA_TRIAGE=claude, or =replay for cache only).
 *
 * The pass/fail verdict NEVER depends on this. It only adds a plain-English
 * explanation and a suggested owner to each problem, to shorten the time from
 * "red build" to "right person looking at it".
 *
 * Data minimisation: Claude receives only the redacted failure description
 * the reporter already produced (journey, step, assertion text). No
 * screenshots, no page content, no traces, no credentials.
 */

const Triage = z.object({
  category: z.enum(["product-bug", "test-or-test-data-issue", "environment-or-infrastructure"]),
  explanation: z.string(),
  likely_owner: z.string(),
  next_step: z.string(),
});
type TriageResult = z.infer<typeof Triage>;

const MODEL = process.env.QA_TRIAGE_MODEL ?? "claude-opus-5-5";
const PROMPT_VERSION = "triage-v1";
const CACHE_DIR = path.join("qa", ".ai-cache", "triage");

const SYSTEM = `You triage failures from an automated end-to-end QA run of a multi-tenant AI platform used by pharmaceutical and healthcare teams.
For each failure you get: the product area, the user journey, the step that failed and the assertion messages.
Decide whether it is most likely a product bug, a problem with the test or its data, or an environment/infrastructure problem.
Write "explanation" for a product manager: two short sentences, no jargon, say what a real user would experience.
"likely_owner" is a team or component name (e.g. "Auth team", "Documents API", "AI jobs pipeline", "Frontend").
"next_step" is one concrete action. Do not invent facts that are not in the input.`;

function render(t: TriageResult): string {
  return `${t.category.replace(/-/g, " ")}. ${t.explanation} Likely owner: ${t.likely_owner}. Next step: ${t.next_step}`;
}

export async function triageProblems(problems: Problem[]): Promise<number> {
  const mode = process.env.QA_TRIAGE ?? "off";
  if (mode !== "claude" && mode !== "replay") return 0;
  const client = mode === "claude" ? new Anthropic() : null;
  let done = 0;

  for (const p of problems) {
    const input = JSON.stringify({
      area: p.area,
      severity: p.severity,
      journey: p.tests[0],
      also_affected: p.tests.length - 1,
      failed_step: p.failedStep,
      problem: p.headline,
      details: p.details,
    });
    const key = createHash("sha256").update(`${MODEL}\n${PROMPT_VERSION}\n${input}`).digest("hex");
    const file = path.join(CACHE_DIR, `${key}.json`);

    let result: TriageResult | null = null;
    try {
      result = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      if (!client) continue;
      try {
        const res = await client.beta.messages.parse({
          model: MODEL,
          max_tokens: 4000,
          output_config: { effort: "low", format: betaZodOutputFormat(Triage) },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: SYSTEM,
          messages: [{ role: "user", content: input }],
        });
        if (res.stop_reason !== "refusal" && res.parsed_output) {
          result = res.parsed_output;
          mkdirSync(CACHE_DIR, { recursive: true });
          writeFileSync(file, JSON.stringify(result, null, 2));
        }
      } catch (error) {
        if (error instanceof Anthropic.AuthenticationError) {
          console.warn("AI triage skipped: Anthropic credentials are not configured.");
          return done;
        }
        console.warn(`AI triage skipped for one problem: ${(error as Error).message}`);
      }
    }
    if (result) {
      p.triage = render(result);
      done++;
    }
  }
  return done;
}
