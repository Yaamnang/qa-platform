"use client";

import { ActivityIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui";
import { JobHistory } from "../job-history";
import { useWorkspace, WorkspaceReady } from "../workspace";

export default function HistoryPage() {
  return (
    <WorkspaceReady>
      <HistoryContent />
    </WorkspaceReady>
  );
}

/** Every Explore and Probe run of this workspace, newest first. A row opens the run's own page. */
function HistoryContent() {
  const { jobs } = useWorkspace();
  return (
    <JobHistory jobs={jobs} showSource={jobs.some((j) => j.trigger === "github")}
      empty={
        <EmptyState icon={<ActivityIcon className="size-5" />} title="No runs yet">
          Runs started from Explore, Probe or GitHub appear here.
        </EmptyState>
      } />
  );
}
