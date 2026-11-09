"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { AppShell, useMe } from "@/components/AppShell";
import { ActivityIcon, AlertIcon, CheckCircleIcon, ChevronRightIcon, FileIcon, SparkleIcon, Spinner, TrashIcon, UploadIcon } from "@/components/icons";
import { Badge, Button, Card, EmptyState, formatBytes, formatDate, Notice, PageHeader } from "@/components/ui";
import { api, ApiError, useFlags } from "@/lib/client/api";

type Doc = { id: string; name: string; rows: number; sizeBytes: number; uploadedAt: number };
type JobSummary = { id: string; documentName: string; status: string; stage: string; createdAt: number };

const STAGE_LABEL: Record<string, string> = {
  queued: "Queued", reading: "Reading file", analyzing: "Analyzing", writing: "Writing report", complete: "Complete",
};

function loadWorkspace() {
  return Promise.all([
    api<{ documents: Doc[] }>("/api/documents"),
    api<{ jobs: JobSummary[] }>("/api/jobs"),
  ]);
}

export default function WorkspacePage() {
  return (
    <AppShell>
      <Workspace />
    </AppShell>
  );
}

function Workspace() {
  const router = useRouter();
  const me = useMe();
  // Viewers are read-only: no upload, delete or analyse controls (the server refuses them too).
  const canEdit = me?.role === "admin";
  const flags = useFlags();
  const fileRef = useRef<HTMLInputElement>(null);
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [chosen, setChosen] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Doc | null>(null);

  const refresh = useCallback(async () => {
    const [d, j] = await loadWorkspace();
    setDocs(d.documents);
    setJobs(j.jobs);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadWorkspace()
      .then(([d, j]) => {
        if (cancelled) return;
        setDocs(d.documents);
        setJobs(j.jobs);
      })
      .catch(() => !cancelled && setMessage({ kind: "error", text: "Could not load your documents." }));
    return () => {
      cancelled = true;
    };
  }, []);

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (!file || !fileRef.current) return;
    const dt = new DataTransfer();
    dt.items.add(file);
    fileRef.current.files = dt.files;
    setChosen(file);
  }

  function clearChoice() {
    if (fileRef.current) fileRef.current.value = "";
    setChosen(null);
  }

  async function upload(e: FormEvent) {
    e.preventDefault();
    if (flags.has("upload-button-dead")) return; // injected regression
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setMessage({ kind: "error", text: "Choose a CSV file first." });
      return;
    }
    setUploading(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const { document } = await api<{ document: Doc }>("/api/documents", { method: "POST", body: form });
      setMessage({ kind: "success", text: `Uploaded ${document.name} (${document.rows} rows).` });
      clearChoice();
      await refresh();
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof ApiError ? err.message : "Upload failed." });
    } finally {
      setUploading(false);
    }
  }

  async function analyse(doc: Doc) {
    setStarting(doc.id);
    try {
      const { job } = await api<{ job: { id: string } }>("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentId: doc.id }),
      });
      router.push(`/jobs/${job.id}`);
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof ApiError ? err.message : "Could not start analysis." });
      setStarting(null);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const doc = pendingDelete;
    setPendingDelete(null);
    try {
      await api(`/api/documents/${doc.id}`, { method: "DELETE" });
      setMessage({ kind: "success", text: `Deleted ${doc.name}.` });
      await refresh();
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof ApiError ? err.message : "Delete failed." });
    }
  }

  const completed = jobs.filter((j) => j.status === "succeeded").length;
  const running = jobs.filter((j) => j.status === "running").length;

  return (
    <>
      <PageHeader title="Documents" description={<>Upload adverse-event listings and analyse them with AI. Everything here stays inside {me?.tenant.name}.</>} />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat icon={<FileIcon className="size-4" />} label="Documents" value={docs?.length ?? "–"} />
        <Stat icon={<ActivityIcon className="size-4" />} label="Analyses running" value={running} />
        <Stat icon={<CheckCircleIcon className="size-4" />} label="Analyses completed" value={completed} />
      </div>

      {message && <Notice kind={message.kind} className="mb-6">{message.text}</Notice>}

      {!canEdit && (
        <Notice kind="info" className="mb-6">
          You have read-only access to {me?.tenant.name}. You can view documents and analyses, but only admins can upload, delete or analyse.
        </Notice>
      )}

      {canEdit && <Card title="Upload a dataset" description="CSV with columns subject_id, arm, adverse_event and severity (age optional). Max 1 MB.">
        <form onSubmit={upload} className="space-y-4">
          <label htmlFor="file"
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors ${
              dragging ? "border-brand-400 bg-brand-50" : "border-ink-200 bg-ink-50/60 hover:border-brand-300 hover:bg-brand-50/40"}`}>
            <span className="mb-3 flex size-10 items-center justify-center rounded-xl bg-white text-brand-600 shadow-sm ring-1 ring-ink-200">
              <UploadIcon className="size-5" />
            </span>
            <span className="text-sm font-medium text-ink-800">
              Drop a CSV file here, or <span className="text-brand-600 underline-offset-2 hover:underline">browse</span>
            </span>
            <span className="mt-1 text-xs text-ink-500">Only synthetic or de-identified data in this demo.</span>
          </label>
          <input id="file" ref={fileRef} type="file" accept=".csv,text/csv" aria-label="CSV file" className="sr-only"
            onChange={(e) => setChosen(e.target.files?.[0] ?? null)} />

          <div className="flex flex-wrap items-center justify-between gap-3">
            {chosen ? (
              <span className="inline-flex min-w-0 items-center gap-2 rounded-lg bg-ink-100 px-3 py-1.5 text-sm text-ink-700">
                <FileIcon className="size-4 shrink-0 text-ink-500" />
                <span className="truncate">{chosen.name}</span>
                <span className="text-ink-500">· {formatBytes(chosen.size)}</span>
                <button type="button" onClick={clearChoice} className="ml-1 text-xs font-medium text-ink-500 hover:text-ink-900">Clear selection</button>
              </span>
            ) : (
              <span className="text-sm text-ink-500">No file chosen</span>
            )}
            <Button type="submit" loading={uploading} loadingText="Uploading…" icon={<UploadIcon className="size-4" />}>Upload</Button>
          </div>
        </form>
      </Card>}

      <Card title="Your documents" bodyClassName=""
        action={docs && docs.length > 0 ? <Badge>{docs.length} {docs.length === 1 ? "file" : "files"}</Badge> : undefined}>
        {docs === null ? (
          <div className="space-y-3 p-5" aria-busy="true">
            <span className="sr-only">Loading documents</span>
            {[0, 1, 2].map((i) => <div key={i} className="h-10 animate-pulse rounded-lg bg-ink-100" />)}
          </div>
        ) : docs.length === 0 ? (
          <EmptyState icon={<FileIcon className="size-5" />} title="No documents yet">
            {canEdit ? "Upload a CSV above to run your first analysis." : "Documents uploaded by an admin will appear here."}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-ink-50 text-xs font-medium text-ink-500">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Name</th>
                  <th className="px-3 py-2.5 font-medium">Rows</th>
                  <th className="px-3 py-2.5 font-medium">Size</th>
                  <th className="px-3 py-2.5 font-medium">Uploaded</th>
                  <th className="px-5 py-2.5 text-right font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {docs.map((d) => (
                  <tr key={d.id} className="transition-colors hover:bg-ink-50/70">
                    <td className="max-w-xs px-5 py-3">
                      <span className="flex items-center gap-3">
                        <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 ring-1 ring-emerald-100">
                          <FileIcon className="size-4" />
                        </span>
                        <span className="truncate font-medium text-ink-900">{d.name}</span>
                      </span>
                    </td>
                    <td className="px-3 py-3 tabular-nums text-ink-700">{d.rows}</td>
                    <td className="px-3 py-3 tabular-nums text-ink-500">{formatBytes(d.sizeBytes)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-ink-500">{formatDate(d.uploadedAt)}</td>
                    <td className="px-5 py-3">
                      {canEdit && <div className="flex justify-end gap-1.5">
                        <Button size="sm" onClick={() => analyse(d)} aria-label={`Analyze ${d.name}`} loading={starting === d.id}
                          disabled={starting !== null} icon={<SparkleIcon className="size-3.5" />}>
                          Analyze
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setPendingDelete(d)} aria-label={`Delete ${d.name}`}
                          className="hover:bg-red-50 hover:text-red-600">
                          <TrashIcon className="size-4" />
                        </Button>
                      </div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Recent analyses" bodyClassName="">
        {jobs.length === 0 ? (
          <EmptyState icon={<SparkleIcon className="size-5" />} title="No analyses yet">
            {canEdit ? "Click Analyze on a document to start one. It takes about half a minute." : "Analyses started by an admin will appear here."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-ink-100">
            {jobs.slice(0, 10).map((j) => (
              <li key={j.id}>
                <Link href={`/jobs/${j.id}`} className="group flex items-center gap-3 px-5 py-3 transition-colors hover:bg-ink-50/70">
                  <JobStatusIcon status={j.status} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink-900">{j.documentName}</span>
                    <span className="block text-xs text-ink-500">{formatDate(j.createdAt)}</span>
                  </span>
                  <JobBadge job={j} />
                  <ChevronRightIcon className="size-4 text-ink-400 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {pendingDelete && (
        <div className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-ink-900/40 p-4 backdrop-blur-[2px]"
          onClick={() => setPendingDelete(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="delete-title" onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md animate-pop-in rounded-2xl bg-white p-6 shadow-pop">
            <div className="flex gap-4">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600"><TrashIcon className="size-5" /></span>
              <div>
                <h2 id="delete-title" className="text-base font-semibold text-ink-900">Delete document?</h2>
                <p className="mt-1 text-sm text-ink-600">
                  <span className="font-medium text-ink-900">{pendingDelete.name}</span> will be permanently removed. This cannot be undone.
                </p>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setPendingDelete(null)} autoFocus>Cancel</Button>
              <Button variant="danger" onClick={confirmDelete}>Delete permanently</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: number | string }) {
  return (
    <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-card">
      <div className="flex items-center gap-2 text-xs font-medium text-ink-500">
        <span className="text-ink-400">{icon}</span>{label}
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight text-ink-900">{value}</p>
    </div>
  );
}

function JobStatusIcon({ status }: { status: string }) {
  if (status === "running") return <span className="flex size-8 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><Spinner className="size-4" /></span>;
  if (status === "failed") return <span className="flex size-8 items-center justify-center rounded-lg bg-red-50 text-red-600"><AlertIcon className="size-4" /></span>;
  return <span className="flex size-8 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600"><CheckCircleIcon className="size-4" /></span>;
}

function JobBadge({ job }: { job: JobSummary }) {
  if (job.status === "running") return <Badge tone="brand">{STAGE_LABEL[job.stage] ?? job.stage}</Badge>;
  if (job.status === "failed") return <Badge tone="danger">Failed</Badge>;
  return <Badge tone="success">Complete</Badge>;
}
