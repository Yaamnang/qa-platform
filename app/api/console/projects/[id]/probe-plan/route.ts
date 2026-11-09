import { NextResponse, type NextRequest } from "next/server";
import type { ProbePlanInfo } from "@/lib/console/contract";
import { NO_STORE, jsonError, requireEmployee } from "@/lib/console/server/http";
import { getProbePlan, probeKind, setProbePlan } from "@/lib/console/server/probe";
import { getProject } from "@/lib/console/server/store";
import { hasAnthropicKey } from "@/qa/probe/detect";

// Which Probe this workspace gets, and its recorded AI Probe plan, if any. Never a step's typed value.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { denied } = await requireEmployee(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const project = await getProject(id);
  if (!project) return jsonError(404, "Project not found.");
  const [probe, plan] = await Promise.all([probeKind(project), getProbePlan(project.id)]);
  const info: ProbePlanInfo | null = plan && {
    journeys: plan.journeys.map((j) => j.name),
    steps: plan.journeys.reduce((n, j) => n + j.steps.length, 0),
    model: plan.model,
    createdAt: plan.createdAt,
  };
  return NextResponse.json({ probe, plan: info, hasKey: hasAnthropicKey() }, { headers: NO_STORE });
}

// "Re-plan": forget the recorded plan, so the next Probe plans again with Claude.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { denied } = await requireEmployee(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const project = await getProject(id);
  if (!project) return jsonError(404, "Project not found.");
  await setProbePlan(project.id, null);
  return NextResponse.json({ plan: null }, { headers: NO_STORE });
}
