/**
 * The AI Probe's plan and results. A plan is a list of short user journeys;
 * each step is one action plus the observable outcome that proves it worked.
 *
 * The model only ever writes plans in this shape (plan.ts). Running them and
 * judging them is plain Playwright code (execute.ts): no model decides whether
 * a step passed. A plan is saved on the workspace after the first run and
 * replayed later without any model call.
 *
 * Steps are flat on purpose: one object, a handful of optional fields. That is
 * the shape the model fills in through its tool, the shape that is stored, and
 * the shape the console shows.
 */

export const ACTIONS = ["navigate", "click", "fill", "select", "upload", "download"] as const;
export type ProbeActionKind = (typeof ACTIONS)[number];

export const OUTCOMES = [
  "url_changes",
  "url_matches",
  "element_appears",
  "text_appears",
  "dialog_opens",
  "download_arrives",
  "value_persists",
  "something_changes",
] as const;
export type ProbeOutcomeKind = (typeof OUTCOMES)[number];

export type ProbeStep = {
  /** Plain words, for the report and the live caption: "Open the pricing page". */
  title: string;
  action: ProbeActionKind;
  /** navigate: a same-origin path such as /pricing. */
  path?: string;
  /** The element acted on: role plus accessible name, or a data-testid. fill/select/upload may use a label. */
  role?: string;
  name?: string;
  testId?: string;
  label?: string;
  /** fill: obviously fake test data. select: the option's label. Never a secret. */
  value?: string;
  expect: ProbeOutcomeKind;
  /** element_appears: role plus name, or text. text_appears: text. */
  expectRole?: string;
  expectName?: string;
  expectText?: string;
  /** url_matches: a substring of the path, for example /pricing. */
  expectPattern?: string;
  /** download_arrives: the file extension, for example csv. Optional. */
  extension?: string;
  /** Set when a planning run found the declared outcome too specific and kept "something changes" instead. */
  relaxedFrom?: ProbeOutcomeKind;
};

export type ProbeJourney = {
  name: string;
  /** Same-origin path the journey starts from. */
  start: string;
  steps: ProbeStep[];
};

export type ProbePlan = {
  version: 1;
  origin: string;
  model: string;
  createdAt: string;
  journeys: ProbeJourney[];
};

export type StepStatus = "passed" | "failed" | "skipped" | "not-run";

export type StepResult = {
  title: string;
  action: ProbeActionKind;
  expect: ProbeOutcomeKind;
  status: StepStatus;
  /** Why it failed or was skipped, in plain words. */
  reason: string | null;
  durationMs: number;
};

export type JourneyResult = {
  name: string;
  start: string;
  outcome: "passed" | "failed" | "flaky" | "skipped";
  /** Plain headline when it failed, for example: "Download CSV" did not download a file. */
  headline: string | null;
  failedStep: string | null;
  steps: StepResult[];
  durationMs: number;
};

/** How the plan came about, for the log, the job page and the cost line. */
export type ProbeInfo = {
  mode: "planned" | "recorded";
  model: string;
  journeys: number;
  steps: number;
  tokens: { input: number; output: number };
  approxCostUsd: number;
  readOnly: boolean;
};
