"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronRightIcon } from "@/components/icons";
import { Card, formatDate } from "@/components/ui";
import { formatAgo, formatDuration, jobDuration, useNow } from "../../../_components/format";
import { JobStatusLabel } from "../../../_components/status";
import type { WorkspaceJob } from "./workspace";

const COLUMNS = "sm:grid sm:grid-cols-[7rem_minmax(0,1fr)_7rem_5rem_1rem] sm:items-center sm:gap-4";
const COLUMNS_WITH_SOURCE = "sm:grid sm:grid-cols-[7rem_minmax(0,1fr)_7rem_7rem_5rem_1rem] sm:items-center sm:gap-4";

/** Short form of a commit sha, as GitHub shows it. */
export const shortSha = (sha: string) => sha.slice(0, 7);

/** "GitHub abc1234" for a job a push or pull request started. */
export function GithubMarker({ job }: { job: WorkspaceJob }) {
  if (job.trigger !== "github") return null;
  return (
    <span data-testid="job-github-marker" className="inline-flex items-center gap-1.5 text-xs text-ink-500">
      GitHub{job.commit && <span className="font-mono text-ink-600">{shortSha(job.commit.sha)}</span>}
    </span>
  );
}

/** One kind of job, newest first, each row linking to its job page. */
export function JobHistory({ jobs, empty, showSource = false }: { jobs: WorkspaceJob[]; empty: ReactNode; showSource?: boolean }) {
  const now = useNow(30_000);
  const columns = showSource ? COLUMNS_WITH_SOURCE : COLUMNS;

  return (
    <Card title="History" bodyClassName="">
      {jobs.length === 0 ? (
        <div data-testid="jobs-empty">{empty}</div>
      ) : (
        <>
          <div aria-hidden="true" className={`hidden border-b border-ink-100 px-5 py-2.5 text-xs font-medium text-ink-500 ${columns}`}>
            <span>Status</span><span>Result</span>{showSource && <span>Source</span>}<span>Started</span><span>Duration</span><span />
          </div>
          <ul data-testid="job-history" className="divide-y divide-ink-100">
            {jobs.map((job) => {
              const duration = jobDuration(job);
              return (
                <li key={job.id}>
                  <Link href={`/console/jobs/${job.id}`} data-testid="job-row" data-job-id={job.id}
                    className={`group block space-y-1 px-5 py-3 text-sm transition-colors hover:bg-ink-100/60 focus-visible:bg-ink-100/60 focus-visible:outline-none sm:space-y-0 ${columns}`}>
                    <span className="block text-ink-700"><JobStatusLabel job={job} /></span>
                    <span className="block truncate text-ink-600"><JobSummary job={job} /></span>
                    {showSource && <span className="block"><GithubMarker job={job} /></span>}
                    <span className="block text-ink-500" title={formatDate(job.createdAt)}>
                      {now ? formatAgo(job.createdAt, now) : formatDate(job.createdAt)}
                    </span>
                    <span className="block font-mono text-[13px] tabular-nums text-ink-600">
                      {duration === null ? "–" : formatDuration(duration)}
                    </span>
                    <ChevronRightIcon className="hidden size-4 text-ink-400 transition-transform group-hover:translate-x-0.5 sm:block" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Card>
  );
}

/** One line of outcome: counts for a probe, proposals for an explore job. */
export function JobSummary({ job }: { job: WorkspaceJob }) {
  const n = (count: number, word: string) => <><span className="font-mono tabular-nums">{count}</span> {word}</>;
  if (job.status === "error") return <span className="text-ink-500">{job.error ?? "Stopped with an error"}</span>;
  if (job.kind === "qa" && job.result) {
    return <>{n(job.result.passed, "passed")} · {n(job.result.failed, "failed")}{job.result.flaky > 0 && <> · {n(job.result.flaky, "flaky")}</>}{job.result.skipped > 0 && <> · {n(job.result.skipped, "not run")}</>}</>;
  }
  if (job.kind === "explore" && job.proposals) {
    return <>{n(job.proposals.length, "proposed")} · {n(job.approvedProposalIds.length, "approved")}</>;
  }
  return <span className="text-ink-500">–</span>;
}

