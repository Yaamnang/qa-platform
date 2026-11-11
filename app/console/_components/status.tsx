import type { ReactNode } from "react";
import type { Job, JobKind, JobStatus } from "@/lib/console/contract";

/** Colour of a state: green pass, red fail, amber warning, grey idle or skipped. Accent while something runs. */
export type Tone = "pass" | "fail" | "warn" | "idle" | "active";

export const DOT_COLOUR: Record<Tone, string> = {
  pass: "bg-emerald-500",
  fail: "bg-red-500",
  warn: "bg-amber-500",
  idle: "bg-ink-400",
  active: "bg-brand-500 animate-pulse",
};

/** The same colours for a word shown without its dot. */
export const WORD_COLOUR: Record<Tone, string> = {
  pass: "text-emerald-600",
  fail: "text-red-600",
  warn: "text-amber-600",
  idle: "text-ink-500",
  active: "text-brand-600",
};

/** A state shown as a small dot plus a word. With dot={false}, the word alone in the state's colour. */
export function StatusDot({ tone, children, testId, className = "", dot = true }: {
  tone: Tone;
  children: ReactNode;
  testId?: string;
  className?: string;
  dot?: boolean;
}) {
  if (!dot) {
    return <span data-testid={testId} data-tone={tone} className={`font-medium ${WORD_COLOUR[tone]} ${className}`}>{children}</span>;
  }
  return (
    <span data-testid={testId} data-tone={tone} className={`inline-flex items-center gap-2 ${className}`}>
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${DOT_COLOUR[tone]}`} />
      {children}
    </span>
  );
}

export { JOB_KIND_LABEL } from "@/lib/console/contract";

/** Still going: polled, and the chat accepts messages. "waiting" means the run asked the employee something. */
export const isActive = (status: JobStatus) => status === "queued" || status === "running" || status === "waiting";

const JOB_TONE: Record<JobStatus, Tone> = {
  queued: "idle",
  running: "active",
  waiting: "warn",
  passed: "pass",
  failed: "fail",
  error: "warn",
};

/** An explore job does not pass or fail anything, so a clean finish reads "Finished". */
function jobWord(kind: JobKind, status: JobStatus): string {
  if (kind === "explore" && status === "passed") return "Finished";
  return { queued: "Queued", running: "Running", waiting: "Waiting for you", passed: "Passed", failed: "Failed", error: "Error" }[status];
}

export function JobStatusLabel({ job, testId, className, dot }: { job: Pick<Job, "kind" | "status">; testId?: string; className?: string; dot?: boolean }) {
  return (
    <StatusDot tone={JOB_TONE[job.status]} testId={testId} className={className} dot={dot}>
      <span data-status={job.status}>{jobWord(job.kind, job.status)}</span>
    </StatusDot>
  );
}

const SEVERITY_TONE: Record<string, Tone> = { critical: "fail", high: "fail", medium: "warn", low: "idle" };

export function SeverityLabel({ severity, testId }: { severity: string; testId?: string }) {
  const word = severity ? severity[0].toUpperCase() + severity.slice(1).toLowerCase() : "Unrated";
  return (
    <StatusDot tone={SEVERITY_TONE[severity.toLowerCase()] ?? "idle"} testId={testId}>
      <span className="font-medium text-ink-800">{word}</span>
    </StatusDot>
  );
}
