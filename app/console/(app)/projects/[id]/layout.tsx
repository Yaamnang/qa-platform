import { Suspense, type ReactNode } from "react";
import { InlineLoading } from "../../../_components/states";
import { WorkspaceFrame } from "./workspace";

// Dynamic route: the id comes from the URL, so the frame streams in behind a boundary.
export default function WorkspaceLayout({ params, children }: { params: Promise<{ id: string }>; children: ReactNode }) {
  return (
    <Suspense fallback={<InlineLoading label="Loading workspace…" />}>
      <WorkspaceFrame params={params}>{children}</WorkspaceFrame>
    </Suspense>
  );
}
