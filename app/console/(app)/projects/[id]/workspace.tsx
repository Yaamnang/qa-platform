"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, use, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ArrowLeftIcon } from "@/components/icons";
import { PageHeader } from "@/components/ui";
import { api, postJson } from "@/lib/client/api";
import type { Job, JobKind, JobOrigin, Project } from "@/lib/console/contract";
import { errorMessage, isSignedOut } from "../../../_components/api";
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

const SECTIONS = [
  { slug: "explore", label: "Explore" },
  { slug: "probe", label: "Probe" },
  { slug: "github", label: "GitHub" },
] as const;

/**
 * Frame for every page of one workspace: the header (name and target URL) and
 * the left navbar. It loads the workspace once for all three sections and keeps
 * refreshing while one of its jobs is queued or running.
 */
export function WorkspaceFrame({ params, children }: { params: Promise<{ id: string }>; children: ReactNode }) {
  const { id } = use(params);
  const router = useRouter();
  const pathname = usePathname();
  const [data, setData] = useState<{ project: Project; jobs: WorkspaceJob[] } | null>(null);
  const [loadError, setLoadError] = useState<{ text: string; retry: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

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
        if (isSignedOut(err)) router.replace("/console/login");
        else setLoadError({ text: errorMessage(err, "Could not load this workspace."), retry: canRetry(err) });
      }
    };
    load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id, router, attempt]);

  const back = (
    <Link href="/console" data-testid="project-back" className="inline-flex items-center gap-1.5 font-medium text-ink-500 hover:text-ink-900">
      <ArrowLeftIcon className="size-3.5" /> Workspaces
    </Link>
  );

  if (loadError) {
    return (
      <>
        <div className="mb-6 text-sm">{back}</div>
        <LoadError testId="project-error" message={loadError.text}
          onRetry={loadError.retry ? () => { setLoadError(null); reload(); } : undefined} />
      </>
    );
  }
  if (!data) return <InlineLoading label="Loading workspace…" />;

  const { project } = data;
  const base = `/console/projects/${project.id}`;

  return (
    <WorkspaceContext value={{ ...data, reload }}>
      <PageHeader eyebrow={back} title={project.name}
        description={
          <a href={project.targetUrl} target="_blank" rel="noreferrer" data-testid="project-target"
            className="font-mono text-ink-600 underline-offset-4 hover:text-ink-900 hover:underline">
            {project.targetUrl}
          </a>
        } />

      <div className="md:grid md:grid-cols-[10rem_minmax(0,1fr)] md:items-start md:gap-8">
        <nav aria-label="Workspace" data-testid="workspace-nav"
          className="mb-6 flex gap-1 border-b border-ink-200 pb-3 md:sticky md:top-20 md:mb-0 md:flex-col md:border-b-0 md:pb-0">
          {SECTIONS.map((s) => {
            const href = `${base}/${s.slug}`;
            const current = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link key={s.slug} href={href} aria-current={current ? "page" : undefined} data-testid={`workspace-nav-${s.slug}`}
                className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 ${
                  current ? "bg-ink-100 text-ink-900" : "text-ink-500 hover:bg-ink-100/60 hover:text-ink-900"
                }`}>
                {s.label}
              </Link>
            );
          })}
        </nav>
        <div className="min-w-0">{children}</div>
      </div>
    </WorkspaceContext>
  );
}

/** Starts a job of one kind and opens its page. The error is the API's own reason (409 busy, 403 not allowed). */
export function useStartJob(projectId: string, kind: JobKind) {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const { job } = await postJson<{ job: Job }>(`/api/console/projects/${projectId}/jobs`, { kind });
      // Clear before leaving. Next keeps this page's state for when you come
      // back, so a "starting" left set here would keep the button disabled
      // until a full reload. A double click in the gap is harmless: the API
      // refuses a second job with 409 while one is running.
      setStarting(false);
      router.push(`/console/jobs/${job.id}`);
    } catch (err) {
      if (isSignedOut(err)) return router.replace("/console/login");
      setError(errorMessage(err, "Could not start the job. Try again."));
      setStarting(false);
    }
  }

  return { start, starting, error };
}
