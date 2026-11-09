import { redirect } from "next/navigation";
import { Suspense } from "react";

/** A workspace opens on Probe. */
export default function WorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={null}>
      <ToProbe params={params} />
    </Suspense>
  );
}

async function ToProbe({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return redirect(`/console/projects/${encodeURIComponent(id)}/probe`);
}
