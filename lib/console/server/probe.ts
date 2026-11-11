import "server-only";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isSupabaseEnabled } from "@/lib/server/auth-store";
import { assertOk, client } from "@/lib/server/store-supabase";
import { hasAnthropicKey, isStandIn, NO_KEY_NO_PLAN } from "@/qa/probe/detect";
import type { ProbePlan } from "@/qa/probe/types";
import type { Job, ProbeJourneyResult, ProbeRunInfo } from "../contract";
import type { ProjectRecord } from "./records";

/**
 * The console's side of the Probe (kind "qa").
 *
 * Which Probe: the stand-in gets the built-in suite, which always uploads and
 * deletes in its QA tenant, so it only starts when the run may change data.
 * Any other site gets the AI Probe, which is allowed anywhere: when the run
 * may not change data it skips every step that would (qa/probe/session.ts).
 *
 * Whether a run may change data is decided per run by the caller (start.ts)
 * and reaches the child as PROBE_WRITES_ALLOWED.
 *
 * The recorded plan: after the first AI Probe on a workspace, the journeys it
 * ran are saved here, and every later Probe replays them with no model call.
 * Stored in memory on the default backend, and in console_projects.probe_plan
 * on Supabase (db/schema-console.sql). "Re-plan" on the Probe tab clears it.
 */

export type ProbeKind = "builtin" | "ai";

export async function probeKind(project: ProjectRecord): Promise<ProbeKind> {
  return (await isStandIn(project.targetUrl)) ? "builtin" : "ai";
}

export const STAND_IN_NEEDS_WRITES =
  "This target is the stand-in. Its built-in suite saves, uploads and deletes, so it cannot run read-only. Use Full access test on this target.";

/** Null when the Probe may start, otherwise the reason, for a 403 or 422. */
export async function probeRefusal(project: ProjectRecord, writes: boolean): Promise<{ status: number; error: string } | null> {
  if ((await probeKind(project)) === "builtin") {
    return writes ? null : { status: 403, error: STAND_IN_NEEDS_WRITES };
  }
  if (!hasAnthropicKey() && !(await getProbePlan(project.id))) return { status: 422, error: NO_KEY_NO_PLAN };
  return null;
}

// ---------------------------------------------------------------------------
// The recorded plan, in both stores
// ---------------------------------------------------------------------------

const PROJECTS = "console_projects";
const globalForPlans = globalThis as unknown as { __eclypseProbePlans?: Map<string, ProbePlan> };
const memoryPlans = () => (globalForPlans.__eclypseProbePlans ??= new Map());

function isPlan(value: unknown): value is ProbePlan {
  const p = value as ProbePlan;
  return typeof p === "object" && p !== null && Array.isArray(p.journeys) && p.journeys.length > 0;
}

export async function getProbePlan(projectId: string): Promise<ProbePlan | null> {
  if (!isSupabaseEnabled()) return structuredClone(memoryPlans().get(projectId) ?? null);
  const { data, error } = await client().from(PROJECTS).select("probe_plan").eq("id", projectId).maybeSingle();
  if (error) {
    // Most likely the column has not been added yet (db/schema-console.sql). Planning again is the safe answer.
    console.error("[console] Could not read the recorded Probe plan:", error.message);
    return null;
  }
  const plan = (data as { probe_plan?: unknown } | null)?.probe_plan;
  return isPlan(plan) ? plan : null;
}

export async function setProbePlan(projectId: string, plan: ProbePlan | null): Promise<void> {
  if (!isSupabaseEnabled()) {
    if (plan) memoryPlans().set(projectId, structuredClone(plan));
    else memoryPlans().delete(projectId);
    return;
  }
  const { error } = await client().from(PROJECTS).update({ probe_plan: plan }).eq("id", projectId);
  assertOk(error, "probe plan update");
}

// ---------------------------------------------------------------------------
// The child process
// ---------------------------------------------------------------------------

const PLAN_IN = "probe-plan-in.json";
const PLAN_OUT = "probe-plan-out.json";

/**
 * Extra environment for a Probe child. The model key goes to it so the AI
 * Probe can plan; qa/probe/run.ts strips it again before it starts the
 * built-in suite. The key's value is redacted from the log like every other
 * secret (runner.ts secretsToHide).
 */
export async function probeChildEnv(project: ProjectRecord, dir: string, writes: boolean): Promise<Record<string, string>> {
  mkdirSync(dir, { recursive: true });
  const env: Record<string, string> = {
    PROBE_DIR: dir,
    PROBE_PLAN_OUT: path.join(dir, PLAN_OUT),
    PROBE_WRITES_ALLOWED: writes ? "1" : "0",
  };
  rmSync(env.PROBE_PLAN_OUT, { force: true });
  const plan = await getProbePlan(project.id).catch(() => null);
  if (plan) {
    env.PROBE_PLAN_IN = path.join(dir, PLAN_IN);
    writeFileSync(env.PROBE_PLAN_IN, JSON.stringify(plan));
  }
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "EXPLORE_MODEL", "PROBE_MAX_STEPS", "PROBE_MAX_TOKENS"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

/** After the child: a planning run left the journeys it ran; they become the workspace's recorded plan. */
export async function saveRecordedPlan(projectId: string, dir: string): Promise<void> {
  const file = path.join(dir, PLAN_OUT);
  if (!existsSync(file)) return;
  try {
    const plan: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (isPlan(plan)) await setProbePlan(projectId, plan);
  } catch (err) {
    console.error("[console] Could not save the recorded Probe plan:", err instanceof Error ? err.message : err);
  }
}

/** The AI Probe's extra summary fields, for Job.result. Absent for the built-in suite. */
export function probeExtras(summary: unknown, clean: (text: string) => string): Pick<NonNullable<Job["result"]>, "journeys" | "probe"> {
  const s = summary as { journeys?: unknown; probe?: unknown };
  if (!Array.isArray(s.journeys)) return {};
  const journeys = (s.journeys as ProbeJourneyResult[]).map((j) => ({
    name: clean(String(j.name)),
    start: clean(String(j.start)),
    outcome: j.outcome,
    headline: j.headline === null ? null : clean(String(j.headline)),
    failedStep: j.failedStep === null ? null : clean(String(j.failedStep)),
    durationMs: Number(j.durationMs) || 0,
    steps: (Array.isArray(j.steps) ? j.steps : []).map((step) => ({
      title: clean(String(step.title)),
      action: step.action,
      expect: step.expect,
      status: step.status,
      reason: step.reason === null ? null : clean(String(step.reason)),
      durationMs: Number(step.durationMs) || 0,
    })),
  }));
  const probe = (s.probe ?? null) as ProbeRunInfo | null;
  return { journeys, probe: probe && { ...probe, model: clean(String(probe.model)) } };
}
