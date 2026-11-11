"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ActivityIcon } from "@/components/icons";
import { Button, EmptyState, Notice } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { GithubLink, Job, JobAccess } from "@/lib/console/contract";
import { isSignedOut } from "../../../../_components/api";
import { StatusDot } from "../../../../_components/status";
import { RunStudio } from "../run-studio";
import { useStartJob, useWorkspace, WorkspaceReady } from "../workspace";
import { GithubTest, QueryFlag } from "./github-test";
import { ProbePlanPanel } from "./probe-plan";

export default function ProbePage() {
  return (
    <WorkspaceReady>
      <ProbeContent />
    </WorkspaceReady>
  );
}

/** The page itself. Only rendered once the workspace has loaded. */
function ProbeContent() {
  const { project, jobs, reload } = useWorkspace();
  // The run shown in the middle. null means the newest.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Which button started the run being started, so only that one shows a spinner.
  const [chosen, setChosen] = useState<JobAccess>("read");
  const [confirming, setConfirming] = useState(false);
  const [githubOpen, setGithubOpen] = useState(false);
  const [checkingGithub, setCheckingGithub] = useState(false);
  const router = useRouter();
  const showStarted = (job: Job) => {
    setSelectedId(job.id);
    reload();
  };
  const { startWithAccess, starting, error } = useStartJob(project.id, "qa", showStarted);
  const history = jobs.filter((j) => j.kind === "qa");
  const host = new URL(project.targetUrl).hostname;

  // One panel at a time: opening the confirm closes the GitHub form and the other way round.
  function openConfirm() {
    setGithubOpen(false);
    setConfirming(true);
  }
  function openGithub() {
    setConfirming(false);
    setGithubOpen(true);
  }
  // The code test needs the workspace's GitHub token. Without one, go to the
  // GitHub tab, which comes back here with the form open (?github-test=1) once
  // the token is saved. If the check itself fails, open the form anyway: the
  // test route answers "Connect GitHub first." too.
  async function startGithubTest() {
    setCheckingGithub(true);
    try {
      const { github } = await api<{ github: GithubLink }>(`/api/console/projects/${project.id}/github`);
      if (!github.connected) return router.push(`/console/projects/${project.id}/github?from=code-test`);
      openGithub();
    } catch (err) {
      if (isSignedOut(err)) return router.replace("/login");
      openGithub();
    } finally {
      setCheckingGithub(false);
    }
  }
  function closePanels() {
    setConfirming(false);
    setGithubOpen(false);
  }
  const showStartedAndClose = (job: Job) => {
    closePanels();
    showStarted(job);
  };

  function run(access: JobAccess) {
    setChosen(access);
    closePanels();
    startWithAccess(access);
  }

  const toolbar = (
    <>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => run("read")} loading={starting && chosen === "read"} disabled={starting}
            title="Plans and explores. Never saves, uploads or deletes." data-testid="job-start-qa">
            Explore
          </Button>
          {/* On an allow-listed host (this machine) it starts at once, anywhere else it asks first. */}
          <Button variant="secondary" onClick={() => (project.qaRunAllowed ? run("full") : openConfirm())}
            loading={starting && chosen === "full"} disabled={starting}
            title="May save, upload and delete on the target." data-testid="job-start-full">
            Full access test
          </Button>
          <Button variant="secondary" onClick={startGithubTest} loading={checkingGithub} aria-expanded={githubOpen}
            title="Probe the newest commit of a GitHub repo you collaborate on." data-testid="job-start-github">
            GitHub code test
          </Button>
          {/* Placeholder for a later feature. Disabled on purpose: it does nothing yet. */}
          <Button variant="secondary" disabled title="Not available yet" data-testid="job-start-pentest">
            Pentest
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-600">
          {project.qaEmail && <span data-testid="project-qa-email" className="truncate font-mono text-[13px]">{project.qaEmail}</span>}
          <StatusDot tone={project.hasCredentials ? "pass" : "idle"} testId="project-credentials">
            {project.hasCredentials ? "Credentials stored" : "Asks for sign-in in the job chat"}
          </StatusDot>
        </div>
      </div>
      {confirming && (
        <div role="alertdialog" aria-labelledby="job-full-confirm-text" data-testid="job-full-confirm"
          className="mt-4 max-w-xl rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p id="job-full-confirm-text" className="text-sm text-amber-900">
            This run can save, upload and delete on <span className="font-mono">{host}</span>. Only do this on a site you own.
          </p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={() => run("full")} data-testid="job-start-full-confirm">Run with full access</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} data-testid="job-start-full-cancel">Cancel</Button>
          </div>
        </div>
      )}
      {/* Back from connecting GitHub on the GitHub tab: open the form straight away. */}
      <QueryFlag name="github-test" clear onFound={openGithub} />
      {githubOpen && <GithubTest projectId={project.id} onStarted={showStartedAndClose} onClose={() => setGithubOpen(false)} />}
      <ProbePlanPanel projectId={project.id} version={history.map((j) => `${j.id}:${j.status}`).join(",")} />
      {error && <Notice kind="error" className="mt-4" testId="job-start-error">{error}</Notice>}
    </>
  );

  return (
    <RunStudio jobs={history} selectedId={selectedId} toolbar={toolbar}
      empty={
        <EmptyState icon={<ActivityIcon className="size-5" />} title="No probes yet">
          A probe signs in as the QA account and uses the target the way a real user would.
        </EmptyState>
      } />
  );
}
