"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useRef, useState } from "react";
import { formatDate, Notice } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { Job, JobExplorer, JobOrigin, Project } from "@/lib/console/contract";
import { errorMessage, isSignedOut } from "../../../_components/api";
import { formatAgo, formatDuration, useNow } from "../../../_components/format";
import { isActive, JOB_KIND_LABEL, JobStatusLabel } from "../../../_components/status";
import { canRetry, InlineLoading, LoadError } from "../../../_components/states";
import { JobChat } from "./chat";
import { Fixes } from "./fixes";
import { JobSummaryPanel, LivePanel, useLiveFrame } from "./live";
import { Proposals } from "./proposals";
import { QaResult } from "./qa-result";
import { LogLines } from "./log-lines";
import { ProbeJourneys } from "./probe-journeys";
import { RunError } from "./run-error";
import { StopButton } from "./stop-button";

const POLL_MS = 1500;
const RETRY_MS = 3000;
/** The summary is written a few seconds after the job ends, so a finished job is polled a little longer for it. */
const SUMMARY_WAIT_MS = 20_000;

/**
 * One job. While it is queued, running or waiting for an answer: status,
 * elapsed time, the live view of the QA browser next to the chat, and the log,
 * polled every 1.5 s. Once it finishes, polling stops (after the summary has
 * arrived) and the result shows: the summary, then the verdict and problems for
 * a probe or the proposals for an explore job. The last live frame stays, marked Finished.
 */
export function JobView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [job, setJob] = useState<(Job & Partial<JobOrigin>) | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<{ text: string; retry: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  // A poll failed after the job had loaded: keep showing it and keep trying.
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let stopped = false;
    let loaded = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await api<{ job: Job & Partial<JobOrigin> }>(`/api/console/jobs/${id}`);
        if (stopped) return;
        loaded = true;
        setJob(r.job);
        setStale(false);
        const awaitingSummary = !r.job.summary && r.job.finishedAt !== null && Date.now() - r.job.finishedAt < SUMMARY_WAIT_MS;
        if (isActive(r.job.status) || awaitingSummary) timer = setTimeout(poll, POLL_MS);
      } catch (err) {
        if (stopped) return;
        if (isSignedOut(err)) return router.replace("/login");
        if (!loaded) return setLoadError({ text: errorMessage(err, "Could not load this job."), retry: canRetry(err) });
        setStale(true);
        timer = setTimeout(poll, RETRY_MS);
      }
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id, router, attempt]);

  // The project's name and URL for the header. The page works without them.
  const projectId = job?.projectId;
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    api<{ project: Project }>(`/api/console/projects/${projectId}`)
      .then((r) => !cancelled && setProject(r.project))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const active = job ? isActive(job.status) : false;
  const now = useNow(active ? 1000 : 30_000);
  const live = useLiveFrame(id, active);

  // Breadcrumb: Workspaces / the workspace / this run. The workspace link opens the tab this run belongs to.
  const back = (
    <>
      <Link href="/console" className="font-medium text-ink-500 hover:text-ink-900">Workspaces</Link>
      {job && (
        <>
          <span aria-hidden="true" className="text-ink-300">/</span>
          <Link href={`/console/projects/${job.projectId}/${job.kind === "qa" ? "probe" : "explore"}`} data-testid="job-back"
            className="truncate font-medium text-ink-500 hover:text-ink-900">
            {project?.name ?? "Workspace"}
          </Link>
        </>
      )}
    </>
  );

  if (loadError) {
    return (
      <>
        <nav aria-label="Breadcrumb" className="mb-5 flex items-center gap-2 text-sm">{back}</nav>
        <LoadError testId="job-load-error" message={loadError.text}
          onRetry={loadError.retry ? () => { setLoadError(null); setAttempt((n) => n + 1); } : undefined} />
      </>
    );
  }
  if (!job) return <InlineLoading label="Loading job…" />;

  const started = job.startedAt ?? job.createdAt;
  const end = job.finishedAt ?? now;
  const elapsed = end ? Math.max(0, end - started) : null;
  const finished = job.status === "passed" || job.status === "failed";
  const showResult = finished && job.kind === "qa" && job.result !== null;

  const meta = (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span data-testid="job-id" className="font-mono text-[13px] text-ink-600">{job.id}</span>
      <span aria-hidden="true">·</span>
      <span title={formatDate(started)}>
        {job.startedAt ? "Started" : "Queued"} {now ? formatAgo(started, now) : formatDate(started)}
      </span>
      {job.trigger === "github" && job.commit && (
        <>
          <span aria-hidden="true">·</span>
          <span data-testid="job-github-commit">GitHub <span className="font-mono text-[13px] text-ink-600">{job.commit.sha.slice(0, 7)}</span></span>
        </>
      )}
      {project && (
        <>
          <span aria-hidden="true">·</span>
          <span className="font-mono text-[13px] text-ink-600">{project.targetUrl}</span>
        </>
      )}
    </span>
  );

  // A finished QA run shows its verdict in large type below, so the header leaves the status out.
  const status = showResult ? undefined : (
    <div className="flex items-center gap-4 text-sm text-ink-800">
      <JobStatusLabel job={job} testId="job-status" />
      {elapsed !== null && (
        <span data-testid="job-elapsed" className="font-mono tabular-nums text-ink-600">{formatDuration(elapsed)}</span>
      )}
      {active && <StopButton jobId={job.id} />}
    </div>
  );

  return (
    <>
      <header className="mb-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-sm">
            {back}
            <span aria-hidden="true" className="text-ink-300">/</span>
            <h1 className="text-base font-semibold text-ink-900">{JOB_KIND_LABEL[job.kind]}</h1>
          </nav>
          <div className="mt-1 text-xs text-ink-500">{meta}</div>
        </div>
        {status}
      </header>

      {/* The run on the left, its chat on the right. Below lg the chat drops under the run. */}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0">
          {stale && <Notice kind="warning" className="mb-6" testId="job-stale">Lost contact with the server. Retrying.</Notice>}

          {/* Why it stopped comes first: without it the rest of the page makes no sense. */}
          {job.status === "error" && <RunError error={job.error} testId="job-error" />}

          {/* The triage list shows in Fixes, so the summary panel keeps only the text. */}
          {!active && job.summary && <JobSummaryPanel summary={{ ...job.summary, triage: undefined }} />}
          {!active && <Fixes job={job} />}

          {active && (
            <>
              <LivePanel frame={live} finished={false} className="mb-6" />
              <div className="mb-6">
                <LogPanel text={job.logTail} />
              </div>
            </>
          )}

          {finished && job.kind === "qa" && (
            job.result
              ? <><QaResult result={job.result} jobId={job.id} /><ProbeJourneys result={job.result} /></>
              : <Notice kind="warning" className="mb-6" testId="job-no-result">This run finished without a result. The log below shows how far it got.</Notice>
          )}

          {finished && job.kind === "explore" && job.explorer && (
            <p data-testid="job-explorer" className="mb-6 text-sm text-ink-500">{explorerText(job.explorer)}</p>
          )}

          {finished && job.kind === "explore" && <Proposals job={job} onChange={setJob} />}

          {!active && live.src && <LivePanel frame={live} finished className="mb-6" />}

          {!active && (
            <details open={job.status === "error"} className="overflow-hidden rounded-xl border border-ink-200 bg-white">
              <summary data-testid="job-log-toggle"
                className="cursor-pointer select-none px-5 py-3.5 text-sm font-medium text-ink-700 hover:text-ink-900">
                Log
              </summary>
              <LogText text={job.logTail} className="max-h-96 border-t border-ink-200" />
            </details>
          )}
        </div>
        <div className="min-w-0 lg:sticky lg:top-20 lg:h-[calc(100vh-9rem)]">
          <JobChat job={job} onChange={setJob} className="lg:h-full" />
        </div>
      </div>
    </>
  );
}

/** "claude-haiku-5-5" reads as "Claude Haiku". Anything unrecognised is shown as the model id. */
function modelName(model: string): string {
  const family = /haiku|sonnet|opus/i.exec(model)?.[0];
  return family ? `Claude ${family[0].toUpperCase()}${family.slice(1).toLowerCase()}` : model;
}

/** One quiet line on how the explorer ran, e.g. "Explored with Claude Haiku, 14 steps, about $0.02". */
function explorerText(e: JobExplorer): string {
  if (e.mode === "rules") return "Explored with built-in rules";
  const steps = `${e.steps} ${e.steps === 1 ? "step" : "steps"}`;
  if (e.mode === "replay") return `Replayed a recorded ${modelName(e.model)} exploration, ${steps}, no spend`;
  const cost = e.approxCostUsd === 0 ? "no spend" : e.approxCostUsd < 0.01 ? "under $0.01" : `about $${e.approxCostUsd.toFixed(2)}`;
  return `Explored with ${modelName(e.model)}, ${steps}, ${cost}`;
}

/** The live log, in a panel that follows the newest line unless the reader scrolls up. */
function LogPanel({ text }: { text: string }) {
  return (
    <section aria-label="Log" className="overflow-hidden rounded-xl border border-ink-200 bg-white">
      <div className="border-b border-ink-200 px-5 py-3 text-sm font-medium text-ink-700">Log</div>
      <LogText text={text} className="min-h-48 max-h-[28rem]" follow />
    </section>
  );
}

function LogText({ text, className = "", follow = false }: { text: string; className?: string; follow?: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (follow && el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [text, follow]);

  return (
    <pre ref={ref} data-testid="job-log" tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
      }}
      className={`overflow-auto whitespace-pre-wrap break-words bg-ink-50 px-5 py-4 font-mono text-xs leading-5 text-ink-700 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand-500 ${className}`}>
      <LogLines text={text} />
    </pre>
  );
}
