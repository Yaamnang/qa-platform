"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, use, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, postJson } from "@/lib/client/api";
import type { Job, JobAccess, JobKind, JobOrigin, Project } from "@/lib/console/contract";
import { errorMessage, isSignedOut } from "../../../_components/api";
import { useSetTopBarCrumb } from "../../../_components/ConsoleShell";
import { isActive } from "../../../_components/status";
import { canRetry, InlineLoading, LoadError } from "../../../_components/states";

const POLL_MS = 2000;

/** The API merges trigger and commit into every job. Older servers leave them out, which reads as manual. */
export type WorkspaceJob = Job & Partial<JobOrigin>;

type Workspace = { project: Project; jobs: WorkspaceJob[]; reload: () => void };

const WorkspaceContext = createContext<Workspace | null>(null);

/** The open workspace and its jobs, newest first. Only inside the workspace layout. */
export function useWorkspace(): Workspace {
  const ws = useContext(WorkspaceContext);
  if (!ws) throw new Error("useWorkspace is used outside the workspace layout.");
  return ws;
}

/**
 * Shows its children once the workspace has loaded, a loading line before that.
 * Each section page wraps its content in this, so the content can call
 * useWorkspace() and always get a loaded workspace.
 */
export function WorkspaceReady({ children }: { children: ReactNode }) {
  const ws = useContext(WorkspaceContext);
  if (!ws) return <InlineLoading label="Loading workspace…" />;
  return children;
}

/**
 * Frame for every page of one workspace. The name and target link show in the
 * console's top bar and the section links in its left rail (both ConsoleShell),
 * so this renders the section page straight away. It loads the workspace once for all sections and keeps
 * refreshing while one of its jobs is queued or running.
 *
 * The section page renders from the first render, before the
 * workspace loads. Next prerenders this frame with no data and validates the
 * page under it, so holding the page back here would hide it from that check.
 * The pages wait for the data inside WorkspaceReady. The error screen replaces
 * the page only after the load has actually failed in the browser.
 */
export function WorkspaceFrame({ params, children }: { params: Promise<{ id: string }>; children: ReactNode }) {
  const { id } = use(params);
  const router = useRouter();
  const [data, setData] = useState<{ project: Project; jobs: WorkspaceJob[] } | null>(null);
  const [loadError, setLoadError] = useState<{ text: string; retry: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const setCrumb = useSetTopBarCrumb();

  // Hand the name and target up to the top bar once loaded. Cleared when this
  // frame goes or the id changes. The id check skips data left from another workspace.
  const name = data?.project.id === id ? data.project.name : null;
  const url = data?.project.id === id ? data.project.targetUrl : null;
  useEffect(() => {
    if (name === null || url === null) return;
    setCrumb({ name, url });
    return () => setCrumb(null);
  }, [name, url, setCrumb]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const r = await api<{ project: Project; jobs: WorkspaceJob[] }>(`/api/console/projects/${id}`);
        if (stopped) return;
        setData({ project: r.project, jobs: [...r.jobs].sort((a, b) => b.createdAt - a.createdAt) });
        if (r.jobs.some((j) => isActive(j.status))) timer = setTimeout(load, POLL_MS);
      } catch (err) {
        if (stopped) return;
        if (isSignedOut(err)) router.replace("/login");
        else setLoadError({ text: errorMessage(err, "Could not load this workspace."), retry: canRetry(err) });
      }
    };
    load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id, router, attempt]);

  if (loadError) {
    return (
      <>
        <LoadError testId="project-error" message={loadError.text}
          onRetry={loadError.retry ? () => { setLoadError(null); reload(); } : undefined} />
        <Link href="/console" data-testid="project-back" className="mt-4 inline-block text-sm font-medium text-brand-600 hover:text-brand-700">
          Back to workspaces
        </Link>
      </>
    );
  }

  return (
    <WorkspaceContext value={data ? { ...data, reload } : null}>
      {children}
    </WorkspaceContext>
  );
}

/**
 * Starts a job of one kind. With onStarted the caller gets the new job and the
 * page stays put; without it the job's own page opens. The error is the API's
 * own reason (409 busy, 403 not allowed).
 *
 * start() sends no access, which the API reads as "read". startWithAccess
 * sends the Probe's per-run choice: "read" or "full".
 */
export function useStartJob(projectId: string, kind: JobKind, onStarted?: (job: Job) => void) {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(access?: JobAccess) {
    setStarting(true);
    setError(null);
    try {
      const { job } = await postJson<{ job: Job }>(`/api/console/projects/${projectId}/jobs`, access ? { kind, access } : { kind });
      // Clear before handing over. When the job page opens, Next keeps this
      // page's state for when you come back, so a "starting" left set here
      // would keep the button disabled until a full reload. A double click in
      // the gap is harmless: the API refuses a second job with 409 while one is running.
      setStarting(false);
      if (onStarted) onStarted(job);
      else router.push(`/console/jobs/${job.id}`);
    } catch (err) {
      if (isSignedOut(err)) return router.replace("/login");
      setError(errorMessage(err, "Could not start the job. Try again."));
      setStarting(false);
    }
  }

  // start takes no argument, so onClick={start} never sends the click event as the access.
  const start = () => run();
  const startWithAccess = (access: JobAccess) => run(access);
  return { start, startWithAccess, starting, error };
}
