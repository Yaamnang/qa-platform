import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { LoadingScreen } from "@/components/ui";
import { JobView } from "./job-view";

// Dynamic route: the shell reads the URL, so it streams in behind a boundary.
export default function JobPage({ params }: PageProps<"/jobs/[id]">) {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <AppShell>
        <JobView params={params} />
      </AppShell>
    </Suspense>
  );
}
