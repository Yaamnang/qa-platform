import type { Job, RunProblem } from "@/lib/console/contract";
import { formatDuration } from "../../../_components/format";
import { DOT_COLOUR, SeverityLabel, type Tone } from "../../../_components/status";
import { ReportDownload } from "./report-download";

type Result = NonNullable<Job["result"]>;

const VERDICT: Record<Result["verdict"], { text: string; tone: Tone }> = {
  PASS: { text: "text-emerald-400", tone: "pass" },
  FAIL: { text: "text-red-400", tone: "fail" },
  ERROR: { text: "text-amber-400", tone: "warn" },
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function summary(r: Result): string {
  const notRun = r.skipped > 0 ? ` ${plural(r.skipped, "check")} did not run.` : "";
  if (r.verdict === "ERROR") return "The run did not finish, so the counts below are incomplete.";
  if (r.verdict === "FAIL") return `${plural(r.problems.length || r.failed, "problem")} found.${notRun}`;
  return (r.flaky > 0 ? `No problems. ${plural(r.flaky, "check")} passed only on retry.` : "No problems found.") + notRun;
}

/** Most serious first. The runner already sorts this way; sorting again keeps it true whatever the API sends. */
const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const bySeverity = (a: RunProblem, b: RunProblem) =>
  (SEVERITY_ORDER[a.severity.toLowerCase()] ?? 4) - (SEVERITY_ORDER[b.severity.toLowerCase()] ?? 4);

/** A finished QA run: the verdict first, then the counts, then each problem. */
export function QaResult({ result, jobId }: { result: Result; jobId?: string }) {
  const v = VERDICT[result.verdict] ?? VERDICT.ERROR;
  const problems = [...result.problems].sort(bySeverity);
  return (
    <>
      <section aria-label="Verdict" data-testid="qa-result" className="mb-8 overflow-hidden rounded-xl border border-ink-200 bg-white">
        <div className="px-6 pb-6 pt-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <p data-testid="qa-verdict" data-verdict={result.verdict}
              className={`flex items-center gap-4 text-6xl font-semibold leading-none tracking-tight ${v.text}`}>
              <span aria-hidden="true" className={`size-5 shrink-0 rounded-full ${DOT_COLOUR[v.tone]}`} />
              {result.verdict}
            </p>
            {jobId && <ReportDownload jobId={jobId} />}
          </div>
          <p data-testid="qa-summary" className="mt-4 text-base text-ink-700">{summary(result)}</p>
        </div>
        <dl data-testid="qa-counts" className="grid grid-cols-2 border-t border-ink-200 sm:grid-cols-5 sm:divide-x sm:divide-ink-200">
          <Count label="Passed" value={result.passed} tone="pass" testId="qa-count-passed" />
          <Count label="Failed" value={result.failed} tone="fail" testId="qa-count-failed" />
          <Count label="Flaky" value={result.flaky} tone="warn" testId="qa-count-flaky" />
          <Count label="Not run" value={result.skipped} tone="idle" testId="qa-count-not-run" />
          <div className="px-5 py-4">
            <dt className="text-xs font-medium text-ink-500">Duration</dt>
            <dd data-testid="qa-duration" className="mt-1 font-mono text-2xl tabular-nums text-ink-900">{formatDuration(result.durationMs)}</dd>
          </div>
        </dl>
        {result.runId && (
          <p className="border-t border-ink-200 px-6 py-3 text-xs text-ink-500">
            Run <span data-testid="qa-run-id" className="font-mono text-ink-600">{result.runId}</span>
          </p>
        )}
      </section>

      {problems.length > 0 && (
        <section aria-labelledby="problems-heading" className="mb-8">
          <h2 id="problems-heading" className="mb-4 text-[15px] font-semibold text-ink-900">Problems</h2>
          <ol data-testid="problem-list" className="space-y-4">
            {problems.map((p, i) => <ProblemCard key={`${i}-${p.headline}`} problem={p} index={i + 1} jobId={jobId} />)}
          </ol>
        </section>
      )}
    </>
  );
}

function Count({ label, value, tone, testId }: { label: string; value: number; tone: Tone; testId: string }) {
  return (
    <div className="px-5 py-4">
      <dt className="flex items-center gap-2 text-xs font-medium text-ink-500">
        <span aria-hidden="true" className={`size-2 rounded-full ${value > 0 ? DOT_COLOUR[tone] : DOT_COLOUR.idle}`} />
        {label}
      </dt>
      <dd data-testid={testId} className="mt-1 font-mono text-2xl tabular-nums text-ink-900">{value}</dd>
    </div>
  );
}

function ProblemCard({ problem: p, index, jobId }: { problem: RunProblem; index: number; jobId?: string }) {
  return (
    <li data-testid="problem-card" className="rounded-xl border border-ink-200 bg-white p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-mono text-ink-500">{index}</span>
        <SeverityLabel severity={p.severity} testId="problem-severity" />
        <span aria-hidden="true" className="text-ink-300">/</span>
        <span data-testid="problem-area" className="text-ink-600">{p.area}</span>
      </div>
      <h3 data-testid="problem-headline" className="mt-2.5 text-lg font-semibold leading-snug text-ink-900">{p.headline}</h3>

      {p.failedStep && (
        <p className="mt-3 text-sm">
          <span className="text-ink-500">Failing step: </span>
          <span data-testid="problem-step" className="text-ink-800">{p.failedStep}</span>
        </p>
      )}

      {p.details.length > 0 && (
        <ul data-testid="problem-details" className="mt-3 space-y-1.5 rounded-lg bg-ink-50 px-4 py-3 font-mono text-xs leading-5 text-ink-700">
          {p.details.map((d, i) => <li key={i} className="break-words">{d}</li>)}
        </ul>
      )}

      {jobId && p.image ? (
        <p className="mt-3 text-sm">
          <a href={`/api/console/jobs/${encodeURIComponent(jobId)}/images/${p.image}`} target="_blank" rel="noopener noreferrer"
            data-testid="problem-image" className="text-brand-600 underline-offset-2 hover:underline">
            Image {p.image}
          </a>
        </p>
      ) : p.imageNote ? (
        <p data-testid="problem-image-note" className="mt-3 text-xs text-ink-500">{p.imageNote}</p>
      ) : null}

      {p.tests.length > 0 && (
        <div className="mt-3 text-xs text-ink-500">
          <p>{p.tests.length === 1 ? "Affected check" : `Affected checks (${p.tests.length})`}</p>
          <ul className="mt-1 space-y-0.5 text-ink-600">
            {p.tests.map((t) => <li key={t}>{t}</li>)}
          </ul>
        </div>
      )}
    </li>
  );
}
