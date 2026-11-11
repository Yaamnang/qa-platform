import "server-only";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import {
  computeFindings,
  METRIC_LABELS,
  type Finding,
  type MetricKey,
  type Report,
} from "./analysis";
import type { CsvTable } from "./csv";
import { toCsv } from "./csv";

/**
 * AI analysis for the stand-in platform.
 *
 * AI_MODE=mock    (default) fake AI: correct numbers, but the summary is worded
 *                 differently on every run, like a real model. Free, no network.
 * AI_MODE=claude  real Claude call (Haiku by default). Responses are cached on
 *                 disk keyed by a hash of (model, prompt version, input), so a
 *                 re-run with the same input replays the recorded answer:
 *                 identical output, zero cost ("record once, replay many").
 *                 No key configured: falls back to the fake AI and says so.
 *                 Key configured but the call fails: the job FAILS (never a
 *                 silent fallback, or a broken integration would look healthy).
 * AI_MODE=replay  cache only; a cache miss fails the job instead of spending.
 * AI_MODE unset   claude if a real ANTHROPIC_API_KEY is configured, else mock.
 *                 (`npm run qa` always sets AI_MODE, mock unless asked.)
 */

const PROMPT_VERSION = "ae-summary-v1";
const MODEL = process.env.CLAUDE_MODEL ?? "claude-haiku-5-5";
const CACHE_DIR = process.env.AI_CACHE_DIR ?? path.join(process.cwd(), ".ai-cache");

const METRICS = [
  "total_events",
  "unique_subjects",
  "events_treatment",
  "events_placebo",
  "severe_events",
  "most_common_event",
] as const satisfies readonly MetricKey[];

const ClaudeReportSchema = z.object({
  findings: z.array(
    z.object({
      metric: z.enum(METRICS),
      value: z.string(),
      count: z.number().int().nullable(),
    }),
  ),
  summary: z.string(),
});

const SYSTEM_PROMPT = `You are the analysis engine of a clinical-data platform.
You receive an adverse-event listing as CSV with columns subject_id, arm, age, adverse_event, severity.

Return exactly one finding for each metric:
- total_events: number of data rows (do not count the header).
- unique_subjects: number of distinct subject_id values.
- events_treatment: rows where arm is "treatment".
- events_placebo: rows where arm is "placebo".
- severe_events: rows where severity is "severe".
- most_common_event: the adverse_event value (lowercase, as written in the data) that occurs most often; break ties alphabetically. Put the event name in "value" and its row count in "count".
For numeric metrics, "value" is the integer written as digits and "count" is null.

Count carefully; these numbers are shown to clinicians and checked automatically.
Then write "summary": 2-3 plain sentences describing the safety picture for a study manager. Do not give medical advice. Only mention numbers that also appear in your findings.`;

export class AiJobError extends Error {}

type Mode = "mock" | "claude" | "replay";

function requestedMode(): Mode {
  const m = process.env.AI_MODE;
  if (!m) return hasClaudeCredentials() ? "claude" : "mock";
  return m === "claude" || m === "replay" ? m : "mock";
}

/** A real-looking key or token is configured (placeholders don't count). */
export function hasClaudeCredentials(): boolean {
  const key = (process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? "").trim();
  return key.length > 20 && !/change-me|placeholder|your[-_ ]?key|\.\.\./i.test(key);
}

/** The mode actually in effect, shown on /api/health and in every report. */
export function aiMode(): string {
  const m = requestedMode();
  if (m === "claude" && !hasClaudeCredentials()) return "mock (claude requested, no API key configured)";
  return m === "claude" ? `claude (${MODEL})` : m;
}

// ---------------------------------------------------------------------------
// Fake AI
// ---------------------------------------------------------------------------

const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

function mockReport(table: CsvTable, note?: string): Report {
  const findings = computeFindings(table);
  const v = (m: MetricKey) => findings.find((f) => f.metric === m)!;
  const total = v("total_events").value;
  const subjects = v("unique_subjects").value;
  const severe = v("severe_events").value;
  const top = v("most_common_event");

  // Same facts, different wording each time, like a real model.
  const opening = pick([
    `The listing contains ${total} adverse events across ${subjects} subjects.`,
    `${subjects} subjects reported a total of ${total} adverse events.`,
    `In total, ${total} adverse events were recorded for ${subjects} subjects.`,
  ]);
  const severity = pick([
    `${severe} of these were graded severe.`,
    `Severe events accounted for ${severe} of the reports.`,
    `A small share (${severe}) were classed as severe.`,
  ]);
  const commonest = pick([
    `${top.value[0].toUpperCase()}${top.value.slice(1)} was the most frequently reported event (${top.count} reports).`,
    `The most common event was ${top.value}, with ${top.count} reports.`,
    `Reports of ${top.value} were the most frequent (${top.count}).`,
  ]);
  const closing = pick([
    "Events occurred in both the treatment and placebo arms.",
    "Both study arms reported events.",
    "",
  ]);

  return {
    findings,
    summary: [opening, severity, commonest, closing].filter(Boolean).join(" "),
    model: "fake-analyst-v1",
    generatedBy: "mock",
    ...(note ? { note } : {}),
  };
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

function cacheKey(table: CsvTable): string {
  const input = toCsv([table.header, ...table.rows]);
  return createHash("sha256").update(`${MODEL}\n${PROMPT_VERSION}\n${input}`).digest("hex");
}

async function readCache(key: string): Promise<Report | null> {
  try {
    return JSON.parse(await readFile(path.join(CACHE_DIR, `${key}.json`), "utf8"));
  } catch {
    return null;
  }
}

async function writeCache(key: string, report: Report): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(report, null, 2));
}

async function callClaude(table: CsvTable): Promise<Report> {
  const client = new Anthropic();
  const csv = toCsv([table.header, ...table.rows]);

  let response;
  try {
    response = await client.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium", format: zodOutputFormat(ClaudeReportSchema) },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Adverse-event listing:\n\n${csv}` }],
    });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      throw new AiJobError("The AI service rejected the platform's credentials.");
    } else if (error instanceof Anthropic.RateLimitError) {
      throw new AiJobError("The AI service is busy (rate limited). Please retry.");
    } else if (error instanceof Anthropic.APIError) {
      throw new AiJobError(`AI service error (${error.status ?? "network"}).`);
    }
    console.error("[ai] Claude call failed:", (error as Error).message);
    throw new AiJobError("The AI service is not available right now.");
  }

  if (response.stop_reason === "refusal") {
    throw new AiJobError("The AI service declined to analyse this file.");
  }
  const parsed = response.parsed_output;
  if (!parsed) throw new AiJobError("The AI service returned an unreadable result.");

  // Normalise: one finding per metric, fixed order, platform-owned labels.
  const findings: Finding[] = METRICS.map((metric) => {
    const f = parsed.findings.find((x) => x.metric === metric);
    if (!f) throw new AiJobError(`The AI result is missing "${metric}".`);
    return metric === "most_common_event"
      ? { metric, label: METRIC_LABELS[metric], value: f.value.trim().toLowerCase(), count: f.count ?? 0 }
      : { metric, label: METRIC_LABELS[metric], value: f.value.trim() };
  });

  return { findings, summary: parsed.summary, model: response.model, generatedBy: "claude" };
}

export async function analyse(table: CsvTable): Promise<Report> {
  const mode = requestedMode();
  if (mode === "mock") return mockReport(table);

  const key = cacheKey(table);
  const cached = await readCache(key);
  if (cached) return cached;
  if (mode === "replay") {
    throw new AiJobError("No recorded AI response for this input (replay mode).");
  }
  if (!hasClaudeCredentials()) {
    return mockReport(table, "Claude was requested but no API key is configured, so the built-in fake AI produced this report.");
  }
  const report = await callClaude(table);
  await writeCache(key, report);
  return report;
}
