"use client";

import { useState } from "react";
import { postJson } from "@/lib/client/api";
import { errorMessage } from "../../../_components/api";

/**
 * Stops a running job (POST /api/console/jobs/:id/stop). The job then ends as
 * an error, "Stopped by <you>", with its log, chat and summary kept. The page
 * picks that up on its next poll; until then the button says "Stopping…".
 */
export function StopButton({ jobId }: { jobId: string }) {
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function stop() {
    setStopping(true);
    setError(null);
    try {
      await postJson(`/api/console/jobs/${jobId}/stop`, {});
    } catch (err) {
      setError(errorMessage(err, "Could not reach the console. Try again."));
      setStopping(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" onClick={stop} disabled={stopping} data-testid="job-stop"
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-red-200 bg-white px-2.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500">
        <span aria-hidden="true" className="size-2 rounded-[2px] bg-current" />
        {stopping ? "Stopping…" : "Stop"}
      </button>
      {error && <span role="alert" data-testid="job-stop-error" className="text-xs text-red-600">{error}</span>}
    </span>
  );
}
