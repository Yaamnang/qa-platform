import "server-only";
import type { CsvTable } from "./csv";

/**
 * The stand-in's AI job analyses an adverse-event listing from a clinical
 * study. Required columns are validated at upload time.
 */
export const REQUIRED_COLUMNS = [
  "subject_id",
  "arm",
  "adverse_event",
  "severity",
] as const;

export type MetricKey =
  | "total_events"
  | "unique_subjects"
  | "events_treatment"
  | "events_placebo"
  | "severe_events"
  | "most_common_event";

export type Finding = {
  metric: MetricKey;
  label: string;
  /** Numeric findings carry a number; most_common_event carries the event name. */
  value: string;
  /** Supporting count (only for most_common_event). */
  count?: number;
};

export type Report = {
  findings: Finding[];
  summary: string;
  model: string;
  generatedBy: "mock" | "claude";
  /** Shown to the user, e.g. when the fake AI stood in for Claude. */
  note?: string;
};

export const METRIC_LABELS: Record<MetricKey, string> = {
  total_events: "Adverse events recorded",
  unique_subjects: "Subjects with at least one event",
  events_treatment: "Events in treatment arm",
  events_placebo: "Events in placebo arm",
  severe_events: "Severe events",
  most_common_event: "Most common adverse event",
};

export function missingColumns(table: CsvTable): string[] {
  return REQUIRED_COLUMNS.filter((c) => !table.header.includes(c));
}

/** Deterministic statistics, used by the mock AI and as the platform's own pipeline. */
export function computeFindings(table: CsvTable): Finding[] {
  const col = (name: string) => table.header.indexOf(name);
  const iSubject = col("subject_id");
  const iArm = col("arm");
  const iEvent = col("adverse_event");
  const iSeverity = col("severity");

  const rows = table.rows;
  const subjects = new Set(rows.map((r) => r[iSubject]?.trim()));
  const arm = (r: string[]) => (r[iArm] ?? "").trim().toLowerCase();
  const counts = new Map<string, number>();
  for (const r of rows) {
    const ev = (r[iEvent] ?? "").trim().toLowerCase();
    counts.set(ev, (counts.get(ev) ?? 0) + 1);
  }
  // Ties broken alphabetically so the result is stable.
  const [topEvent, topCount] = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0] ?? ["none", 0];

  const num = (metric: MetricKey, n: number): Finding => ({
    metric,
    label: METRIC_LABELS[metric],
    value: String(n),
  });

  return [
    num("total_events", rows.length),
    num("unique_subjects", subjects.size),
    num("events_treatment", rows.filter((r) => arm(r) === "treatment").length),
    num("events_placebo", rows.filter((r) => arm(r) === "placebo").length),
    num(
      "severe_events",
      rows.filter((r) => (r[iSeverity] ?? "").trim().toLowerCase() === "severe")
        .length,
    ),
    {
      metric: "most_common_event",
      label: METRIC_LABELS.most_common_event,
      value: topEvent,
      count: topCount,
    },
  ];
}
