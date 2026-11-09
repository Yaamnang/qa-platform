import "server-only";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeOutputs } from "@/qa/explore/emit";
import type { ExploreMap, Proposal as ExplorerProposal, ProposalSet } from "@/qa/explore/types";
import type { JobRecord, ProjectRecord } from "./records";
import { jobDir } from "./runner";

/**
 * The draft spec for an explore job: only the proposals an employee approved,
 * each as test.skip with a TODO, in exactly the style `npm run explore`
 * writes, because it is written by the explorer's own emitter.
 *
 * That emitter only offers writeOutputs(), which writes a map and a draft into
 * a folder, and the explorer is not changed for the console beyond
 * --json-out. So the draft is written into a fresh temporary folder, read
 * back, and the folder is deleted.
 */
export function renderApprovedDraft(job: JobRecord, project: ProjectRecord): { fileName: string; text: string } {
  const approved = (job.proposals ?? []).filter((p) => job.approvedProposalIds.includes(p.id));
  const set: ProposalSet = {
    // The id is the console's, not part of the explorer's shape.
    proposals: approved.map(({ journey, area, severity, steps, expectations }) => ({
      journey,
      area,
      // Checked against the explorer's four severities when the job finished.
      severity: severity as ExplorerProposal["severity"],
      steps,
      expectations,
    })),
    // True by construction: the runner always starts explore with --ai-mode mock.
    source: "mock",
    model: "none",
  };

  const dir = mkdtempSync(path.join(os.tmpdir(), "console-draft-"));
  try {
    const { specPath } = writeOutputs(dir, mapOf(job, project), set);
    return { fileName: path.basename(specPath), text: readFileSync(specPath, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The draft's header names the target, when the explorer finished, and its
 * map file. The explorer wrote that map into this job's folder, so it is used
 * when it is still there: the header then names a file that really exists.
 * Otherwise (folder cleaned up, or another machine) the few fields the header
 * reads are rebuilt from the job.
 */
function mapOf(job: JobRecord, project: ProjectRecord): ExploreMap {
  try {
    const dir = jobDir(job.id);
    const name = existsSync(dir) ? readdirSync(dir).find((file) => file.endsWith(".map.json")) : undefined;
    if (name) return JSON.parse(readFileSync(path.join(dir, name), "utf8")) as ExploreMap;
  } catch {
    // Unreadable: rebuild it below.
  }
  const iso = (ms: number | null) => new Date(ms ?? job.createdAt).toISOString();
  return {
    version: 1,
    target: new URL(project.targetUrl).origin,
    startedAt: iso(job.startedAt),
    finishedAt: iso(job.finishedAt),
    limits: { maxPages: 0, maxDepth: 0, budgetMs: 0 },
    stoppedBecause: "unknown: the explorer's map was no longer on disk",
    signedIn: true,
    organization: null,
    pages: [],
    blockedWrites: [],
    notes: [],
  };
}
