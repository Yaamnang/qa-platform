import type { Job, ProbeJourneyResult, ProbeStepResult } from "@/lib/console/contract";
import { formatDuration } from "../../../_components/format";
import { StatusDot, type Tone } from "../../../_components/status";

type Result = NonNullable<Job["result"]>;

const JOURNEY_TONE: Record<ProbeJourneyResult["outcome"], Tone> = { passed: "pass", failed: "fail", flaky: "warn", skipped: "idle" };
const STEP_TONE: Record<ProbeStepResult["status"], Tone> = { passed: "pass", failed: "fail", skipped: "idle", "not-run": "idle" };
const STEP_WORD: Record<ProbeStepResult["status"], string> = { passed: "Passed", failed: "Failed", skipped: "Skipped", "not-run": "Not run" };

/** How the AI Probe got its plan, in one line. */
function planLine(probe: NonNullable<Result["probe"]>): string {
  const access = probe.readOnly ? "Read-only on this host." : "Writes allowed on this host.";
  if (probe.mode === "recorded") return `Recorded plan, ${probe.journeys} journeys, replayed with no model calls. ${access}`;
  const tokens = probe.tokens.input + probe.tokens.output;
  return `Planned with ${probe.model}: ${tokens.toLocaleString("en-GB")} tokens, about $${probe.approxCostUsd.toFixed(4)}. ${access}`;
}

/** The AI Probe's per-journey breakdown. Renders nothing for the built-in suite, which has no journeys field. */
export function ProbeJourneys({ result }: { result: Result }) {
  const journeys = result.journeys;
  if (!journeys || journeys.length === 0) return null;
  return (
    <section aria-labelledby="journeys-heading" data-testid="probe-journeys" className="mb-8">
      <h2 id="journeys-heading" className="mb-1 text-sm font-semibold text-ink-900">Journeys</h2>
      {result.probe && <p data-testid="probe-plan-line" className="mb-3 text-xs text-ink-500">{planLine(result.probe)}</p>}
      <ol className="divide-y divide-ink-200 overflow-hidden rounded-xl border border-ink-200 bg-white">
        {journeys.map((j, i) => (
          <li key={`${i}-${j.name}`} data-testid="probe-journey" data-outcome={j.outcome} className="px-5 py-4">
            <details open={j.outcome === "failed"}>
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink-900">{j.name}</span>
                  {j.headline && <span className="mt-0.5 block text-sm text-red-400">{j.headline}</span>}
                </span>
                <span className="flex shrink-0 items-center gap-4 text-xs text-ink-600">
                  <span className="font-mono tabular-nums">{formatDuration(j.durationMs)}</span>
                  <StatusDot tone={JOURNEY_TONE[j.outcome]}>{j.outcome[0].toUpperCase() + j.outcome.slice(1)}</StatusDot>
                </span>
              </summary>
              <p className="mt-2 font-mono text-xs text-ink-500">{j.start}</p>
              <ol className="mt-3 space-y-2">
                {j.steps.map((s, k) => (
                  <li key={k} data-testid="probe-step" data-status={s.status} className="flex items-start gap-3 text-sm">
                    <StatusDot tone={STEP_TONE[s.status]} className="w-20 shrink-0 text-xs text-ink-600">{STEP_WORD[s.status]}</StatusDot>
                    <span className="min-w-0">
                      <span className="text-ink-800">{s.title}</span>
                      {s.reason && <span className="block text-xs text-ink-500">{s.reason}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}
