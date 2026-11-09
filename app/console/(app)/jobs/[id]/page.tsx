import { Suspense } from "react";
import { InlineLoading } from "../../../_components/states";
import { JobView } from "./job-view";

// Dynamic route: the id comes from the URL, so the view streams in behind a boundary.
export default function JobPage({ params }: PageProps<"/console/jobs/[id]">) {
  return (
    <Suspense fallback={<InlineLoading label="Loading job…" />}>
      <JobView params={params} />
    </Suspense>
  );
}
