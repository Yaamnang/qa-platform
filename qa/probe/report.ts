import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Summary } from "../reporter/plain-report";
import type { JourneyResult, ProbeInfo } from "./types";

/**
 * The AI Probe's summary.json, in the same shape as the built-in suite's, so
 * the console reads it with the same code (lib/console/server/runner.ts) and
 * the existing result view works. The per-journey breakdown and how the plan
 * came about ride along in two extra fields, journeys and probe.
 */
export type ProbeSummary = Summary & { journeys: JourneyResult[]; probe: ProbeInfo | null };

export function buildSummary(input: {
  runId: string;
  baseURL: string;
  startedAt: Date;
  journeys: JourneyResult[];
  probe: ProbeInfo | null;
  globalErrors: string[];
  notes: string[];
}): ProbeSummary {
  const count = (outcome: JourneyResult["outcome"]) => input.journeys.filter((j) => j.outcome === outcome).length;
  const counts = { passed: count("passed"), failed: count("failed"), flaky: count("flaky"), skipped: count("skipped") };
  const verdict: Summary["verdict"] = input.globalErrors.length || !input.journeys.length
    ? "ENVIRONMENT UNAVAILABLE"
    : counts.failed
      ? "FAIL"
      : "PASS";
  const failed = input.journeys.filter((j) => j.outcome === "failed");
  return {
    runId: input.runId,
    verdict,
    baseURL: input.baseURL,
    target: "ai-probe",
    environment: input.probe ? { probe: input.probe.mode, model: input.probe.model, readOnly: input.probe.readOnly } : null,
    startedAt: input.startedAt.toISOString(),
    durationMs: Date.now() - input.startedAt.getTime(),
    counts,
    problems: failed.map((j) => {
      const step = j.steps.find((s) => s.status === "failed");
      return {
        headline: j.headline ?? `${j.name} failed`,
        details: [step?.reason, `Journey: ${j.name}, from ${j.start}.`].filter((d): d is string => !!d),
        area: j.name,
        severity: "high" as const,
        failedStep: j.failedStep,
        tests: [j.name],
        evidence: {},
      };
    }),
    notRun: counts.skipped ? `${counts.skipped} journey(s) skipped: they would change data, and this host is read-only.` : null,
    warnings: input.notes.map((message) => ({ test: "AI Probe", message })),
    flaky: input.journeys.filter((j) => j.outcome === "flaky").map((j) => j.name),
    globalErrors: input.globalErrors.length || input.journeys.length ? input.globalErrors : ["The plan had no journeys that could run on this site."],
    tests: input.journeys.map((j, i) => ({
      id: `journey-${i + 1}`,
      journey: j.name,
      area: "AI Probe",
      severity: "high" as const,
      outcome: j.outcome,
      durationMs: j.durationMs,
      steps: j.steps.map((s) => ({ title: s.title, failed: s.status === "failed" })),
      failedStep: j.failedStep,
      errors: j.headline ? [j.headline] : [],
      guard: [],
      warnings: [],
      notes: [],
      evidence: {},
    })),
    journeys: input.journeys,
    probe: input.probe,
  };
}

export function renderProbeMarkdown(s: ProbeSummary): string {
  const lines = [
    `# AI Probe: ${s.verdict}`,
    "",
    `Target ${s.baseURL} · ${s.counts.passed} passed · ${s.counts.failed} failed · ${s.counts.flaky} flaky · ${s.counts.skipped} skipped · ${Math.round(s.durationMs / 1000)} s`,
  ];
  if (s.probe) {
    lines.push(
      "",
      s.probe.mode === "recorded"
        ? `Recorded plan, replayed without any model call. ${s.probe.readOnly ? "Read-only on this host." : "Writes allowed on this host."}`
        : `Planned by ${s.probe.model}: ${s.probe.tokens.input} input and ${s.probe.tokens.output} output tokens, about $${s.probe.approxCostUsd.toFixed(4)}. ${s.probe.readOnly ? "Read-only on this host." : "Writes allowed on this host."}`,
    );
  }
  for (const e of s.globalErrors) lines.push("", `! ${e}`);
  for (const j of s.journeys) {
    lines.push("", `## ${j.outcome.toUpperCase()} · ${j.name}`, "", `From ${j.start}${j.headline ? `. ${j.headline}.` : "."}`, "");
    for (const step of j.steps) lines.push(`- ${step.status}: ${step.title}${step.reason ? ` (${step.reason})` : ""}`);
  }
  for (const w of s.warnings) lines.push("", `Note: ${w.message}`);
  return `${lines.join("\n")}\n`;
}

export function writeSummary(root: string, s: ProbeSummary): string {
  const dir = path.join(root, "qa-results", s.runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "summary.json"), JSON.stringify(s, null, 2));
  writeFileSync(path.join(dir, "report.md"), renderProbeMarkdown(s));
  return dir;
}
