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
import { ListSkeleton, LoadError } from "../_components/states";

type ProjectRow = Project & { lastJob: Job | null };

const COLUMNS = "sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_10rem_7rem_1rem] sm:items-center sm:gap-4";

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
        if (isSignedOut(err)) router.replace("/console/login");
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
        <ListSkeleton label="Loading workspaces" />
      ) : projects.length === 0 ? (
        <div data-testid="projects-empty" className="rounded-xl border border-ink-200 bg-white">
          <EmptyState icon={<FileIcon className="size-5" />} title="No workspaces yet">
            Add one with the target URL and the QA account the robot signs in with.
          </EmptyState>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-ink-200 bg-white">
          <div aria-hidden="true" className={`hidden border-b border-ink-200 px-5 py-2.5 text-xs font-medium text-ink-500 ${COLUMNS}`}>
            <span>Name</span><span>Target</span><span>Last job</span><span>Ran</span><span />
          </div>
          <ul data-testid="project-list" className="divide-y divide-ink-100">
            {projects.map((p) => (
              <li key={p.id}>
                <Link href={`/console/projects/${p.id}/probe`} data-testid="project-row" data-project-id={p.id}
                  className={`group block space-y-1 px-5 py-3.5 transition-colors hover:bg-ink-100/60 focus-visible:bg-ink-100/60 focus-visible:outline-none sm:space-y-0 ${COLUMNS}`}>
                  <span className="block truncate text-sm font-medium text-ink-900">{p.name}</span>
                  <span className="block truncate font-mono text-[13px] text-ink-600">{p.targetUrl}</span>
                  <span className="block text-sm text-ink-700">
                    {p.lastJob ? (
                      <><JobStatusLabel job={p.lastJob} /><span className="ml-1.5 text-xs text-ink-500">{JOB_KIND_LABEL[p.lastJob.kind]}</span></>
                    ) : (
                      <StatusDot tone="idle"><span className="text-ink-500">No jobs</span></StatusDot>
                    )}
                  </span>
                  <span className="block text-sm text-ink-500">
                    {p.lastJob ? (
                      <time dateTime={new Date(jobTime(p.lastJob)).toISOString()} title={formatDate(jobTime(p.lastJob))}>
                        {now ? formatAgo(jobTime(p.lastJob), now) : formatDate(jobTime(p.lastJob))}
                      </time>
                    ) : "Never"}
                  </span>
                  <ChevronRightIcon className="hidden size-4 text-ink-400 transition-transform group-hover:translate-x-0.5 sm:block" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
