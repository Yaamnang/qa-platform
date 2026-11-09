"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { AlertIcon, ArrowLeftIcon, CheckIcon, DownloadIcon, SparkleIcon, Spinner } from "@/components/icons";
import { Badge, buttonStyles, Card, Notice, PageHeader } from "@/components/ui";
import { api, ApiError, useFlags } from "@/lib/client/api";

type Finding = { metric: string; label: string; value: string; count?: number };
type Job = {
  id: string;
  documentId: string;
  documentName: string;
  status: "running" | "succeeded" | "failed";
  stage: string;
  progress: number;
  error: string | null;
  report: { findings: Finding[]; summary: string; model: string; generatedBy: string; note?: string } | null;
};

const STAGES = [
  { id: "queued", label: "Queued" },
  { id: "reading", label: "Reading file" },
  { id: "analyzing", label: "Analyzing with AI" },
  { id: "writing", label: "Writing report" },
  { id: "complete", label: "Complete" },
];

export function JobView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const flags = useFlags();
  const [job, setJob] = useState<Job | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const { job } = await api<{ job: Job }>(`/api/jobs/${id}`);
        if (stopped) return;
        setJob(job);
        if (job.status === "running") timer = setTimeout(poll, 500);
      } catch (err) {
        if (!stopped) setLoadError(err instanceof ApiError ? err.message : "Could not load this analysis.");
      }
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id]);

  const back = (
    <Link href="/workspace" className="inline-flex items-center gap-1.5 font-medium text-ink-500 hover:text-ink-900">
      <ArrowLeftIcon className="size-3.5" /> Documents
    </Link>
  );

  if (loadError) {
    return (
      <>
        <div className="mb-6 text-sm">{back}</div>
        <Notice kind="error">{loadError}</Notice>
      </>
    );
  }
  if (!job) {
    return <p className="flex items-center gap-2 text-sm text-ink-500"><Spinner className="size-4 text-brand-500" /> Loading analysis…</p>;
  }

  const currentIndex = STAGES.findIndex((s) => s.id === job.stage);
  const statusBadge =
    job.status === "succeeded" ? <Badge tone="success">Complete</Badge>
    : job.status === "failed" ? <Badge tone="danger">Failed</Badge>
    : <Badge tone="brand"><Spinner className="size-3" /> Running</Badge>;

  return (
    <>
      <PageHeader eyebrow={back} title={`Analysis: ${job.documentName}`} actions={statusBadge} />

      <Card title="Progress">
        <ol aria-label="Analysis stages" className="mb-6 grid grid-cols-5 gap-2">
          {STAGES.map((s, i) => {
            const done = job.status === "succeeded" || (currentIndex > i && job.status !== "failed") || (job.status === "failed" && i < 2);
            const current = s.id === job.stage;
            const failedHere = job.status === "failed" && i === 2;
            return (
              <li key={s.id} aria-current={current ? "step" : undefined} className="relative flex flex-col items-center text-center">
                {i > 0 && (
                  <span aria-hidden="true" className={`absolute right-1/2 top-4 h-0.5 w-full -translate-y-1/2 ${done || current ? "bg-brand-400" : "bg-ink-200"}`} />
                )}
                <span aria-hidden="true" className={`relative z-10 flex size-8 items-center justify-center rounded-full ring-4 ring-white transition-colors ${
                  failedHere ? "bg-red-500 text-white"
                  : done ? "bg-brand-600 text-white"
                  : current ? "bg-brand-50 text-brand-600 ring-brand-100"
                  : "bg-ink-100 text-ink-400"}`}>
                  {failedHere ? <AlertIcon className="size-4" />
                    : done ? <CheckIcon className="size-4" />
                    : current ? <Spinner className="size-4" />
                    : <span className="size-1.5 rounded-full bg-current" />}
                </span>
                <span className={`mt-2 text-xs font-medium ${current || done ? "text-ink-900" : "text-ink-400"}`}>{s.label}</span>
              </li>
            );
          })}
        </ol>
        <div className="flex items-center gap-3">
          <div role="progressbar" aria-label="Analysis progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.progress}
            className="h-2 flex-1 overflow-hidden rounded-full bg-ink-100">
            <div className={`h-full rounded-full transition-all duration-500 ${job.status === "failed" ? "bg-red-500" : "bg-gradient-to-r from-brand-500 to-brand-700"}`}
              style={{ width: `${job.progress}%` }} />
          </div>
          <span aria-hidden="true" className="w-10 text-right text-xs font-medium tabular-nums text-ink-500">{job.progress}%</span>
        </div>
        <p data-testid="job-status" className="mt-3 text-sm text-ink-600">
          {job.status === "running" && `${STAGES[currentIndex]?.label ?? "Working"}… ${job.progress}%`}
          {job.status === "succeeded" && "Analysis complete"}
          {job.status === "failed" && "Analysis failed"}
        </p>
      </Card>

      {job.status === "failed" && (
        <Notice kind="error" className="mb-6">{job.error} You can return to Documents and try again.</Notice>
      )}

      {job.status === "succeeded" && job.report && <Results job={job} crash={flags.has("results-page-crash")} />}
    </>
  );
}

function Results({ job, crash }: { job: Job; crash: boolean }) {
  const report = job.report!;
  // Injected regression: a renamed field makes the results view throw.
  const findings: Finding[] = crash ? (report as unknown as { items: Finding[] }).items : report.findings;
  return (
    <div className="animate-fade-in">
      <Card title="Findings" description="Computed directly from the uploaded file." bodyClassName="">
        <table className="w-full text-left text-sm">
          <thead className="bg-ink-50 text-xs text-ink-500">
            <tr><th className="px-5 py-2.5 font-medium">Metric</th><th className="px-5 py-2.5 text-right font-medium">Value</th></tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {findings.map((f) => (
              <tr key={f.metric} data-metric={f.metric}>
                <td className="px-5 py-3 text-ink-600">{f.label}</td>
                <td className="px-5 py-3 text-right font-semibold tabular-nums text-ink-900">
                  {f.value}{f.count !== undefined && <span className="font-normal text-ink-500">{` (${f.count} reports)`}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="AI summary" action={<Badge tone="brand"><SparkleIcon className="size-3" /> AI-generated</Badge>}>
        <p data-testid="ai-summary" className="text-[15px] leading-7 text-ink-800">{report.summary}</p>
        <p className="mt-4 text-xs text-ink-500">
          Written by {report.model}. Check against the source data before relying on it.
        </p>
        {report.note && <Notice kind="warning" testId="ai-note" className="mt-3">{report.note}</Notice>}
      </Card>

      <div className="flex flex-wrap gap-3">
        <a href={`/api/jobs/${job.id}/report?format=csv`} download className={buttonStyles("primary")}>
          <DownloadIcon className="size-4" /> Download CSV report
        </a>
        <a href={`/api/jobs/${job.id}/report?format=json`} download className={buttonStyles("secondary")}>
          <DownloadIcon className="size-4" /> Download JSON
        </a>
      </div>
    </div>
  );
}
