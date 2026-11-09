"use client";

import { ActivityIcon } from "@/components/icons";
import { Button, EmptyState, Notice } from "@/components/ui";
import { StatusDot } from "../../../../_components/status";
import { JobHistory } from "../job-history";
import { useStartJob, useWorkspace } from "../workspace";
import { ProbePlanPanel } from "./probe-plan";

export default function ProbePage() {
  const { project, jobs } = useWorkspace();
  const { start, starting, error } = useStartJob(project.id, "qa");
  const history = jobs.filter((j) => j.kind === "qa");

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-3">
        <Button onClick={start} loading={starting}
          aria-describedby={project.qaRunAllowed ? undefined : "qa-run-blocked"} data-testid="job-start-qa">
          Probe
        </Button>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-600">
          {project.qaEmail && <span data-testid="project-qa-email" className="truncate font-mono text-[13px]">{project.qaEmail}</span>}
          <StatusDot tone={project.hasCredentials ? "pass" : "idle"} testId="project-credentials">
            {project.hasCredentials ? "Credentials stored" : "Asks for sign-in in the job chat"}
          </StatusDot>
        </div>
      </div>
      {!project.qaRunAllowed && (
        <p id="qa-run-blocked" data-testid="qa-run-blocked" className="-mt-3 mb-6 text-xs text-ink-500">
          This host is not on the allow-list, so the Probe is read-only here: steps that would change data are skipped. The built-in suite for the stand-in still needs the allow-list.
        </p>
      )}

      <ProbePlanPanel projectId={project.id} version={history.map((j) => `${j.id}:${j.status}`).join(",")} />

      {error && <Notice kind="error" className="mb-6" testId="job-start-error">{error}</Notice>}

      <JobHistory jobs={history} showSource={history.some((j) => j.trigger === "github")}
        empty={
          <EmptyState icon={<ActivityIcon className="size-5" />} title="No probes yet">
            A probe signs in as the QA account and uses the target the way a real user would.
          </EmptyState>
        } />
    </>
  );
}
