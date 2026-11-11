"use client";

import { useState } from "react";
import { DownloadIcon } from "@/components/icons";
import { Button, Notice } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import type { Job } from "@/lib/console/contract";
import { errorMessage } from "../../../_components/api";
import { SeverityLabel } from "../../../_components/status";

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

/** Fetch the draft spec and hand it to the browser as a download. */
async function downloadDraft(jobId: string) {
  const res = await fetch(`/api/console/jobs/${jobId}/draft`, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`);
  }
  const blob = await res.blob();
  const name = /filename="?([^";]+)"?/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `${jobId}.draft.spec.txt`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A finished explore job: pick the proposed checks worth keeping, save, download the draft. */
export function Proposals({ job, onChange }: { job: Job; onChange: (job: Job) => void }) {
  const proposals = job.proposals ?? [];
  const saved = new Set(job.approvedProposalIds);
  const [selected, setSelected] = useState(() => new Set(job.approvedProposalIds));
  const [busy, setBusy] = useState<"save" | "download" | null>(null);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const dirty = !sameSet(selected, saved);

  function toggle(id: string) {
    setMessage(null);
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll(on: boolean) {
    setMessage(null);
    setSelected(new Set(on ? proposals.map((p) => p.id) : []));
  }

  async function save() {
    const { job: updated } = await api<{ job: Job }>(`/api/console/jobs/${job.id}/approvals`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvedProposalIds: [...selected] }),
    });
    onChange(updated);
  }

  async function onSave() {
    setBusy("save");
    setMessage(null);
    try {
      await save();
      setMessage({ kind: "success", text: `Saved. ${selected.size} of ${proposals.length} checks approved.` });
    } catch (err) {
      setMessage({ kind: "error", text: errorMessage(err, "Could not save the approvals. Try again.") });
    } finally {
      setBusy(null);
    }
  }

  async function onDownload() {
    setBusy("download");
    setMessage(null);
    try {
      // The draft holds saved approvals only, so save any change first.
      if (dirty) await save();
      await downloadDraft(job.id);
    } catch (err) {
      setMessage({ kind: "error", text: errorMessage(err, "Could not download the draft. Try again.") });
    } finally {
      setBusy(null);
    }
  }

  if (proposals.length === 0) {
    return (
      <Notice kind="info" className="mb-6" testId="proposals-empty">
        The explorer finished without proposing any checks. The log below shows what it reached.
      </Notice>
    );
  }

  const allOn = selected.size === proposals.length;

  return (
    <section aria-labelledby="proposals-heading" className="mb-8">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="proposals-heading" className="text-[15px] font-semibold text-ink-900">
            Proposed checks <span className="font-mono font-normal text-ink-500">{proposals.length}</span>
          </h2>
          <p data-testid="proposals-note" className="mt-1 text-sm text-ink-500">
            Approved checks become a draft spec for a developer to finish. They are not live tests and do not run.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => selectAll(!allOn)} data-testid="proposals-select-all">
          {allOn ? "Clear all" : "Select all"}
        </Button>
      </div>

      <ul data-testid="proposal-list" className="space-y-3">
        {proposals.map((p) => {
          const on = selected.has(p.id);
          return (
            <li key={p.id} data-testid="proposal-item" data-proposal-id={p.id} data-approved={on}
              className={`rounded-xl border bg-white p-5 transition-colors ${on ? "border-brand-300" : "border-ink-200"}`}>
              <div className="flex gap-4">
                <input id={`proposal-${p.id}`} type="checkbox" checked={on} onChange={() => toggle(p.id)}
                  data-testid="proposal-checkbox" className="mt-1 size-4 shrink-0 cursor-pointer accent-brand-500" />
                <div className="min-w-0 flex-1">
                  <label htmlFor={`proposal-${p.id}`} className="block cursor-pointer text-[15px] font-medium leading-snug text-ink-900">
                    {p.journey}
                  </label>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <SeverityLabel severity={p.severity} />
                    <span aria-hidden="true" className="text-ink-300">/</span>
                    <span className="text-ink-600">{p.area}</span>
                  </div>
                  <div className="mt-4 grid gap-5 text-sm sm:grid-cols-2">
                    <div>
                      <h3 className="text-xs font-medium text-ink-500">Steps</h3>
                      <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-ink-700 marker:font-mono marker:text-ink-500">
                        {p.steps.map((s, i) => <li key={i}>{s}</li>)}
                      </ol>
                    </div>
                    <div>
                      <h3 className="text-xs font-medium text-ink-500">Expectations</h3>
                      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-ink-700 marker:text-ink-500">
                        {p.expectations.map((x, i) => <li key={i}>{x}</li>)}
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="sticky bottom-0 z-10 -mx-2 mt-4 border-t border-ink-200 bg-ink-50/95 px-2 py-3 backdrop-blur">
        {message && <Notice kind={message.kind} className="mb-3" testId="approvals-message">{message.text}</Notice>}
        <div className="flex flex-wrap items-center gap-3">
          <p className="mr-auto text-sm text-ink-600">
            <span data-testid="approvals-count" className="font-mono tabular-nums text-ink-900">{selected.size}</span> of{" "}
            <span className="font-mono tabular-nums">{proposals.length}</span> approved
            {dirty && <span className="text-ink-500"> · not saved</span>}
          </p>
          <Button variant="secondary" onClick={onSave} loading={busy === "save"} loadingText="Saving…"
            disabled={busy !== null || !dirty} data-testid="approvals-save">
            Save approvals
          </Button>
          <Button onClick={onDownload} loading={busy === "download"} loadingText="Preparing…"
            disabled={busy !== null || selected.size === 0} icon={<DownloadIcon className="size-4" />} data-testid="draft-download">
            Download draft spec
          </Button>
        </div>
      </div>
    </section>
  );
}
