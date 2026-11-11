"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ChevronRightIcon, FileIcon, PlusIcon } from "@/components/icons";
import { buttonStyles, EmptyState, formatDate, PageHeader } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { Job, Project } from "@/lib/console/contract";
import { errorMessage, isSignedOut } from "../_components/api";
import { formatAgo, jobTime, useNow } from "../_components/format";
import { JOB_KIND_LABEL, JobStatusLabel, StatusDot } from "../_components/status";
import { LoadError } from "../_components/states";

type ProjectRow = Project & { lastJob: Job | null };

/** The grid the cards and their loading placeholders share. */
const GRID = "grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";

/** Placeholder cards while the list loads. */
function CardSkeleton() {
  return (
    <div aria-busy="true" className={GRID}>
      <span className="sr-only">Loading workspaces</span>
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="h-[136px] animate-pulse rounded-xl border border-ink-200 bg-white" />
      ))}
    </div>
  );
}

export default function ProjectsPage() {
  const router = useRouter();
  const now = useNow(30_000);
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api<{ projects: ProjectRow[] }>("/api/console/projects")
      .then((r) => !cancelled && setProjects(r.projects))
      .catch((err) => {
        if (cancelled) return;
        if (isSignedOut(err)) router.replace("/login");
        else setError(errorMessage(err, "Could not load workspaces."));
      });
    return () => {
      cancelled = true;
    };
  }, [router, attempt]);

  function retry() {
    setError(null);
    setProjects(null);
    setAttempt((n) => n + 1);
  }

  const newProject = (
    <Link href="/console/projects/new" data-testid="project-new" className={buttonStyles("primary")}>
      <PlusIcon className="size-4" /> New workspace
    </Link>
  );

  return (
    <>
      <PageHeader title="Workspaces" actions={newProject} />

      {error ? (
        <LoadError testId="projects-error" message={error} onRetry={retry} />
      ) : projects === null ? (
        <CardSkeleton />
      ) : projects.length === 0 ? (
        <div data-testid="projects-empty" className="rounded-xl border border-ink-200 bg-white">
          <EmptyState icon={<FileIcon className="size-5" />} title="No workspaces yet">
            Add one with the target URL and the QA account the robot signs in with.
          </EmptyState>
        </div>
      ) : (
        <ul data-testid="project-list" className={GRID}>
          {/* Newest workspace first. */}
          {[...projects].sort((x, y) => y.createdAt - x.createdAt).map((p) => {
            const ago = (ms: number) => (now ? formatAgo(ms, now) : formatDate(ms));
            return (
              <li key={p.id}>
                <Link href={`/console/projects/${p.id}/probe`} data-testid="project-row" data-project-id={p.id}
                  className="group flex h-full flex-col rounded-xl border border-ink-200 bg-white shadow-card transition duration-150 hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-pop focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500">
                  <div className="flex items-start gap-3 p-5">
                    <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-sm font-semibold uppercase text-brand-700">
                      {p.name.trim()[0] ?? "?"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-[15px] font-semibold text-ink-900">{p.name}</h2>
                      <p title={p.targetUrl} className="mt-0.5 truncate font-mono text-xs text-ink-500">{p.targetUrl}</p>
                    </div>
                    <ChevronRightIcon className="mt-1 size-4 shrink-0 text-ink-300 transition group-hover:translate-x-0.5 group-hover:text-brand-600" />
                  </div>
                  <div className="mt-auto flex items-center justify-between gap-3 border-t border-ink-100 px-5 py-3 text-sm">
                    {p.lastJob ? (
                      <>
                        <span className="min-w-0 truncate text-ink-700">
                          <JobStatusLabel job={p.lastJob} dot={false} /><span className="ml-1.5 text-xs text-ink-500">{JOB_KIND_LABEL[p.lastJob.kind]}</span>
                        </span>
                        <time dateTime={new Date(jobTime(p.lastJob)).toISOString()} title={formatDate(jobTime(p.lastJob))} className="shrink-0 text-xs text-ink-500">
                          {ago(jobTime(p.lastJob))}
                        </time>
                      </>
                    ) : (
                      <>
                        <StatusDot tone="idle" dot={false}>No jobs yet</StatusDot>
                        <time dateTime={new Date(p.createdAt).toISOString()} title={formatDate(p.createdAt)} className="shrink-0 text-xs text-ink-500">
                          Added {ago(p.createdAt)}
                        </time>
                      </>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
