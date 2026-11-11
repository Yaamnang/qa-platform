"use client";

import { useState } from "react";
import { Button, Notice } from "@/components/ui";
import type { Project } from "@/lib/console/contract";
import { api } from "@/lib/client/api";
import { errorMessage } from "../../../../_components/api";

/** Hosts that always have full access: this machine, where a Probe can only touch the local stand-in. */
const THIS_MACHINE = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Not used any more: the Probe tab now chooses access per run with its
 * Explore and Full access test buttons. Kept because files here cannot be deleted.
 *
 * The "Full access" switch: whether the Probe may save, upload and delete on
 * this site. Turning it on asks for a confirmation first; turning it off does
 * not, since that is the safe direction. Locked while a run is active, and the
 * server refuses the change then too (PATCH /api/console/projects/:id), so a
 * run always keeps the access it started with.
 */
export function FullAccess({ project, runActive, onChanged }: { project: Project; runActive: boolean; onChanged: () => void }) {
  const host = new URL(project.targetUrl).hostname;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (THIS_MACHINE.has(host)) {
    return (
      <p data-testid="full-access-local" className="mt-3 text-xs text-ink-500">
        Full access: always on for this machine.
      </p>
    );
  }

  async function save(fullAccess: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/console/projects/${project.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fullAccess }),
      });
      setConfirming(false);
      onChanged();
    } catch (err) {
      setError(errorMessage(err, "Could not save Full access."));
    } finally {
      setBusy(false);
    }
  }

  const on = project.fullAccess;
  return (
    <div className="mt-4" data-testid="full-access">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" role="switch" aria-checked={on} aria-labelledby="full-access-label"
          aria-describedby="full-access-state" disabled={runActive || busy}
          onClick={() => (on ? save(false) : setConfirming(true))} data-testid="full-access-switch"
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${on ? "bg-amber-500" : "bg-ink-300"}`}>
          <span aria-hidden="true" className={`size-4 rounded-full bg-ink-900 transition-transform ${on ? "translate-x-[18px]" : "translate-x-0.5"}`} />
        </button>
        <span id="full-access-label" className="text-sm font-medium text-ink-900">Full access</span>
        <span id="full-access-state" data-testid="full-access-state" className="text-xs text-ink-500">
          {runActive
            ? "Locked while a run is in progress."
            : on
              ? <>The Probe may save, upload and delete on <span className="font-mono">{host}</span>.</>
              : "Read-only. Steps that change data are skipped."}
        </span>
      </div>

      {confirming && !on && (
        <div role="alertdialog" aria-labelledby="full-access-confirm" data-testid="full-access-confirm"
          className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p id="full-access-confirm" className="text-sm text-amber-900">
            The Probe will submit forms, upload and delete on <span className="font-mono">{host}</span>. Only turn this on for a site you own or have permission to test.
          </p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" loading={busy} onClick={() => save(true)} data-testid="full-access-confirm-on">Turn on</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
        </div>
      )}
      {error && <Notice kind="error" className="mt-3" testId="full-access-error">{error}</Notice>}
    </div>
  );
}
