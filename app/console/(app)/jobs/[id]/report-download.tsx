"use client";

import { useState } from "react";
import { Button } from "@/components/ui";

/** Fetch the report and hand it to the browser as a download. */
async function downloadReport(jobId: string): Promise<void> {
  const res = await fetch(`/api/console/jobs/${encodeURIComponent(jobId)}/report`, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
  }
  const blob = await res.blob();
  const name = /filename="?([^";]+)"?/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `probe-report-${jobId}.html`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "Download report": one HTML file with the problems, their images, the fixes and the log. */
export function ReportDownload({ jobId }: { jobId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      await downloadReport(jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not download the report. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="secondary" size="sm" onClick={onClick} loading={busy} loadingText="Preparing…" data-testid="report-download">
        Download report
      </Button>
      {error && <p role="alert" data-testid="report-download-error" className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
