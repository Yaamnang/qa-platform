"use client";

import { SparkleIcon } from "@/components/icons";
import { Button, EmptyState, Notice } from "@/components/ui";
import { JobHistory } from "../job-history";
import { useStartJob, useWorkspace } from "../workspace";

export default function ExplorePage() {
  const { project, jobs } = useWorkspace();
  const { start, starting, error } = useStartJob(project.id, "explore");
  const history = jobs.filter((j) => j.kind === "explore");

  return (
    <>
      <div className="mb-6">
        <Button onClick={start} loading={starting} data-testid="job-start-explore">Explore</Button>
      </div>

      {error && <Notice kind="error" className="mb-6" testId="job-start-error">{error}</Notice>}

      <JobHistory jobs={history}
        empty={
          <EmptyState icon={<SparkleIcon className="size-5" />} title="No explore jobs yet">
            Explore only reads the target and proposes checks.
          </EmptyState>
        } />
    </>
  );
}
