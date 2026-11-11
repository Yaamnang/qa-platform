"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { ProbePlanInfo } from "@/lib/console/contract";
import { errorMessage } from "../../../../_components/api";

type PlanState = { probe: "builtin" | "ai"; plan: ProbePlanInfo | null; hasKey: boolean };

/**
 * Which Probe this workspace gets, and for the AI Probe its recorded plan.
 * "Re-plan" forgets the plan, so the next Probe plans again with Claude Haiku.
 * Reloads whenever the workspace's job list changes, so a new plan shows up
 * as soon as the planning run finishes.
 */
export function ProbePlanPanel({ projectId, version }: { projectId: string; version: string }) {
  const [state, setState] = useState<PlanState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    let stopped = false;
    api<PlanState>(`/api/console/projects/${projectId}/probe-plan`)
      .then((r) => !stopped && setState(r))
      .catch((err) => !stopped && setError(errorMessage(err, "Could not load the Probe plan.")));
    return () => {
      stopped = true;
    };
  }, [projectId, version]);

  const replan = async () => {
    setClearing(true);
    setError(null);
    try {
      await api(`/api/console/projects/${projectId}/probe-plan`, { method: "DELETE" });
      setState((s) => (s ? { ...s, plan: null } : s));
    } catch (err) {
      setError(errorMessage(err, "Could not clear the plan."));
    } finally {
      setClearing(false);
    }
  };

  if (!state) return error ? <p className="mt-3 text-xs text-red-600">{error}</p> : null;
  if (state.probe === "builtin") {
    return <p data-testid="probe-kind" data-probe="builtin" className="mt-3 text-xs text-ink-500">Runs the built-in test suite.</p>;
  }
  return (
    <div data-testid="probe-kind" data-probe="ai" className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-ink-600">
      {state.plan ? (
        <>
          <span data-testid="probe-plan">
            Replays the saved plan: {state.plan.journeys.length} journeys, {state.plan.steps} steps. No AI calls.
          </span>
          <Button variant="secondary" size="sm" onClick={replan} loading={clearing} data-testid="probe-replan">Re-plan</Button>
        </>
      ) : (
        <span data-testid="probe-plan">
          {state.hasKey ? "First run: Claude Haiku plans what to test and the plan is saved. Later runs replay it." : "Needs an Anthropic key to plan the first run."}
        </span>
      )}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
