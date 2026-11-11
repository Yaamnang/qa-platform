import { redirect } from "next/navigation";
import { Suspense } from "react";

/** Explore was removed from the console. Old links, and the back link of old Explore jobs, land on Probe. */
export default function ExplorePage({ params }: { params: Promise<{ id: string }> }) {
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
