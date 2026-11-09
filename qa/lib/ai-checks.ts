import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

/**
 * How the QA system checks AI output that is worded differently on every run.
 *
 * HARD checks (can fail the build) only on things that must always be true:
 *   - every structured number/label equals the ground truth of the synthetic
 *     input file we uploaded ourselves (done in the test);
 *   - the free-text summary is present and has no template/serialisation junk.
 *
 * SOFT checks (warnings in the report, never a red build on their own):
 *   - numbers in the summary that don't appear in the findings;
 *   - an optional Claude "judge" that reads the summary against the facts.
 *
 * Wording changes run to run; facts must not. Gating only on facts is what
 * keeps false alarms down.
 */

export type Facts = {
  total_events: number;
  unique_subjects: number;
  events_treatment: number;
  events_placebo: number;
  severe_events: number;
  most_common_event: { value: string; count: number };
};

const JUNK = [/undefined/i, /\bNaN\b/, /\[object Object\]/, /\{\{.*\}\}/, /lorem ipsum/i, /as an ai (language )?model/i];

/** Problems that make a summary unusable regardless of wording. */
export function summaryHygieneProblems(summary: string): string[] {
  const problems: string[] = [];
  if (summary.trim().length < 40) problems.push(`summary is too short to be useful (${summary.trim().length} chars)`);
  for (const re of JUNK) if (re.test(summary)) problems.push(`summary contains "${summary.match(re)?.[0]}"`);
  return problems;
}

/** Numbers in the summary that are not supported by any finding. */
export function unsupportedNumbers(summary: string, facts: Facts): string[] {
  const allowed = new Set(
    [
      facts.total_events,
      facts.unique_subjects,
      facts.events_treatment,
      facts.events_placebo,
      facts.severe_events,
      facts.most_common_event.count,
    ].map(String),
  );
  const found = summary.match(/\b\d+(?:\.\d+)?\b/g) ?? [];
  return [...new Set(found.filter((n) => !allowed.has(n)))];
}

// ---------------------------------------------------------------------------
// Optional LLM judge (QA_JUDGE=claude). Advisory only.
// Verdicts are cached by a hash of the input, so re-running the same build
// gives the same verdict and costs nothing (QA_JUDGE=replay never calls out).
// ---------------------------------------------------------------------------

const Verdict = z.object({
  faithful: z.boolean(),
  unsupported_claims: z.array(z.string()),
  explanation: z.string(),
});
export type JudgeVerdict = z.infer<typeof Verdict> & { source: "claude" | "cache" };

const JUDGE_MODEL = process.env.QA_JUDGE_MODEL ?? "claude-opus-5-5";
const JUDGE_PROMPT_VERSION = "judge-v1";
const CACHE_DIR = path.join("qa", ".ai-cache", "judge");

export async function judgeSummary(summary: string, facts: Facts): Promise<JudgeVerdict | null> {
  const mode = process.env.QA_JUDGE ?? "off";
  if (mode !== "claude" && mode !== "replay") return null;

  const input = JSON.stringify({ facts, summary });
  const key = createHash("sha256").update(`${JUDGE_MODEL}\n${JUDGE_PROMPT_VERSION}\n${input}`).digest("hex");
  const file = path.join(CACHE_DIR, `${key}.json`);
  try {
    return { ...JSON.parse(readFileSync(file, "utf8")), source: "cache" };
  } catch {
    if (mode === "replay") return null;
  }

  const client = new Anthropic();
  const res = await client.beta.messages.parse({
    model: JUDGE_MODEL,
    max_tokens: 4000,
    output_config: { effort: "low", format: betaZodOutputFormat(Verdict) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system:
      "You check AI-written summaries of clinical safety data for faithfulness. " +
      "You are given verified facts and a summary. A claim is unsupported if it states or implies something the facts do not support " +
      "(wrong numbers, invented events, comparisons the facts don't show, medical advice). Paraphrase and omission are fine. " +
      "Be strict about facts and lenient about style.",
    messages: [{ role: "user", content: `Verified facts:\n${JSON.stringify(facts, null, 2)}\n\nSummary to check:\n${summary}` }],
  });
  if (res.stop_reason === "refusal" || !res.parsed_output) return null;

  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(res.parsed_output, null, 2));
  return { ...res.parsed_output, source: "claude" };
}
