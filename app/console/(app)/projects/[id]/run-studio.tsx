"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Notice } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { Job, JobOrigin } from "@/lib/console/contract";
import { isSignedOut } from "../../../_components/api";
import { formatDuration, useNow } from "../../../_components/format";
import { isActive, JobStatusLabel } from "../../../_components/status";
import { JobChat } from "../../jobs/[id]/chat";
import { Fixes } from "../../jobs/[id]/fixes";
import { JobSummaryPanel, LivePanel, useLiveFrame } from "../../jobs/[id]/live";
import { LogLines } from "../../jobs/[id]/log-lines";
import { RunError } from "../../jobs/[id]/run-error";
import { StopButton } from "../../jobs/[id]/stop-button";
import { ProbeJourneys } from "../../jobs/[id]/probe-journeys";
import { Proposals } from "../../jobs/[id]/proposals";
import { QaResult } from "../../jobs/[id]/qa-result";
import { GithubMarker } from "./job-history";
import type { WorkspaceJob } from "./workspace";

const POLL_MS = 1500;
const RETRY_MS = 3000;
/** The summary is written a few seconds after the job ends, so a finished job is polled a little longer for it. */
const SUMMARY_WAIT_MS = 20_000;

/**
 * The run view of the Explore and Probe tabs: the toolbar and the newest run
 * (the QA browser's screen, then its result and log) on the left, that run's
 * chat on the right. A run started here is shown at once, so you watch it live
 * without leaving the page. Older runs are on the History tab. From lg the
 * chat is its own column on the right; below lg it drops under the run.
 */
export function RunStudio({ jobs, selectedId, toolbar, empty, below }: {
  jobs: WorkspaceJob[];
  selectedId: string | null;
  toolbar: ReactNode;
  empty: ReactNode;
  below?: ReactNode;
}) {
  const current = selectedId ?? jobs[0]?.id ?? null;
  const tools = <div className="mb-6">{toolbar}</div>;
  const after = below && <div className="mt-6">{below}</div>;

  // Keyed by id, so another run starts from a clean state.
  if (current) return <JobStage key={current} jobId={current} toolbar={tools} below={after} />;
  return (
    <StudioColumns
      main={<>{tools}<div data-testid="studio-empty" className="rounded-xl border border-ink-200 bg-white">{empty}</div>{after}</>}
      chat={
        <section aria-label="Chat" data-testid="studio-chat-empty" className="overflow-hidden rounded-xl border border-ink-200 bg-white shadow-sm lg:h-full">
          <div className="border-b border-ink-200 px-5 py-3 text-sm font-semibold text-ink-900">Chat</div>
          <p className="px-5 py-6 text-sm text-ink-500">No run yet.</p>
        </section>
      } />
  );
}

/** The two columns: the run on the left, the chat on the right (under it below lg). */
function StudioColumns({ main, chat }: { main: ReactNode; chat: ReactNode }) {
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="min-w-0">{main}</div>
      <div className="min-w-0 lg:sticky lg:top-20 lg:h-[calc(100vh-9rem)]">{chat}</div>
    </div>
  );
}

/** One run: the live screen, the result once it ends and the log on the left; its chat on the right. */
function JobStage({ jobId, toolbar, below }: { jobId: string; toolbar: ReactNode; below: ReactNode }) {
  const router = useRouter();
  const [job, setJob] = useState<(Job & Partial<JobOrigin>) | null>(null);
  // The last poll failed. Before the first load this is the error state; after it, a stale notice.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await api<{ job: Job & Partial<JobOrigin> }>(`/api/console/jobs/${jobId}`);
        if (stopped) return;
        setJob(r.job);
        setFailed(false);
        const awaitingSummary = !r.job.summary && r.job.finishedAt !== null && Date.now() - r.job.finishedAt < SUMMARY_WAIT_MS;
        if (isActive(r.job.status) || awaitingSummary) timer = setTimeout(poll, POLL_MS);
      } catch (err) {
        if (stopped) return;
        if (isSignedOut(err)) return router.replace("/login");
        setFailed(true);
        timer = setTimeout(poll, RETRY_MS);
      }
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [jobId, router]);

  const active = job ? isActive(job.status) : false;
  const live = useLiveFrame(jobId, active);
  const now = useNow(active ? 1000 : 30_000);

  if (!job) {
    return (
      <StudioColumns chat={null} main={<>
        {toolbar}
        {failed
          ? <Notice kind="warning" testId="studio-load-error">Could not load this run. Retrying.</Notice>
          : <div className="flex aspect-video items-center justify-center rounded-xl border border-ink-200 bg-ink-50 text-sm text-ink-500">Loading run…</div>}
        {below}
      </>} />
    );
  }

  const finished = job.status === "passed" || job.status === "failed";
  const started = job.startedAt ?? job.createdAt;
  // useNow is 0 until its first tick, so fall back to the start time rather than show a negative.
  const elapsed = Math.max(0, (job.finishedAt ?? (now || started)) - started);

  return (
    <StudioColumns chat={<JobChat job={job} onChange={setJob} className="lg:h-full" />} main={<>
    {toolbar}
    <div data-testid="studio-stage" data-job-id={job.id}>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <JobStatusLabel job={job} testId="studio-status" />
        <span data-testid="studio-elapsed" className="font-mono tabular-nums text-ink-600">{formatDuration(elapsed)}</span>
        {active && <StopButton jobId={job.id} />}
        <GithubMarker job={job} />
        <Link href={`/console/jobs/${job.id}`} data-testid="studio-open"
          className="ml-auto font-medium text-ink-500 underline-offset-4 hover:text-ink-900 hover:underline">
          Open full page
        </Link>
      </div>

      {failed && <Notice kind="warning" className="mb-3" testId="studio-stale">Lost contact with the server. Retrying.</Notice>}

      {/* Why it stopped comes first: without it the rest of the page makes no sense. */}
      {job.status === "error" && <RunError error={job.error} testId="studio-error" />}

      {/* The server drops frames when a run ends. A run watched here keeps its last frame; an older one has none. */}
      {live.src || active ? (
        <LivePanel frame={live} finished={!active} className="mb-6" />
      ) : (
        <p data-testid="studio-no-screen" className="mb-6 rounded-lg border border-dashed border-ink-200 px-4 py-3 text-sm text-ink-500">
          No screen recording. The screen is only streamed while a run is live.
        </p>
      )}

      {/* The triage list shows in Fixes, so the summary panel keeps only the text. */}
      {!active && job.summary && <JobSummaryPanel summary={{ ...job.summary, triage: undefined }} />}
      {!active && <Fixes job={job} />}

      {finished && job.kind === "qa" && (
        job.result
          ? <><QaResult result={job.result} jobId={job.id} /><ProbeJourneys result={job.result} /></>
          : <Notice kind="warning" className="mb-6" testId="studio-no-result">This run finished without a result. The log below shows how far it got.</Notice>
      )}
      {finished && job.kind === "explore" && <Proposals job={job} onChange={setJob} />}

      <details open={active || job.status === "error"} className="overflow-hidden rounded-xl border border-ink-200 bg-white">
        <summary className="cursor-pointer select-none px-5 py-3 text-sm font-medium text-ink-700 hover:text-ink-900">Log</summary>
        <LogText text={job.logTail} follow={active} />
      </details>
    </div>
    {below}
    </>} />
  );
}

function LogText({ text, follow }: { text: string; follow: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text, follow]);
  return (
    <pre ref={ref} data-testid="studio-log"
      className="max-h-80 overflow-auto whitespace-pre-wrap break-words border-t border-ink-200 bg-ink-50 px-5 py-4 font-mono text-xs leading-5 text-ink-700">
      <LogLines text={text} />
    </pre>
  );
}
