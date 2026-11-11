"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import type { Job } from "@/lib/console/contract";
import { FIX_CATEGORY_LABEL, fixesFor, fixesMarkdown, type Fix } from "@/lib/console/fixes";
import { StatusDot, type Tone } from "../../../_components/status";

/** Where the fix belongs. Red: the site is broken. Amber: the check is wrong. Grey: nothing could be judged. */
const CATEGORY: Record<Fix["category"], { label: string; tone: Tone }> = {
  product: { label: FIX_CATEGORY_LABEL.product, tone: "fail" },
  test: { label: FIX_CATEGORY_LABEL.test, tone: "warn" },
  environment: { label: FIX_CATEGORY_LABEL.environment, tone: "idle" },
};

/** "Fixes needed" for a finished job: what to fix, where, the evidence, and a copy of it all as Markdown. */
export function Fixes({ job }: { job: Job }) {
  const { items, fromTriage, byClaude } = fixesFor(job);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (copy !== "copied") return;
    const timer = setTimeout(() => setCopy("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copy]);

  // An explore run that found nothing to fix has proposals, not fixes: say nothing.
  if (items.length === 0 && job.kind === "explore") return null;
  if (items.length === 0) {
    return (
      <section aria-label="Fixes needed" data-testid="fixes-panel" className="mb-6">
        <p data-testid="fixes-empty" className="text-sm text-ink-500">Nothing to fix.</p>
      </section>
    );
  }

  const markdown = fixesMarkdown(job, items, byClaude);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopy("copied");
    } catch {
      // No clipboard on plain http, or the browser said no.
      setCopy("failed");
    }
  };

  return (
    <section aria-label="Fixes needed" data-testid="fixes-panel" data-source={fromTriage ? "triage" : "result"}
      className="mb-6 rounded-xl border border-ink-200 bg-white px-5 py-4">
      <div className="mb-3 flex items-center gap-2 text-sm">
        <span className="font-medium text-ink-700">Fixes needed</span>
        <span className="font-mono text-xs text-ink-500">{items.length}</span>
        {byClaude && <span data-testid="fixes-by" className="text-xs text-ink-500">by Claude, advisory</span>}
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onCopy} data-testid="fixes-copy">
          {copy === "copied" ? "Copied" : "Copy"}
        </Button>
      </div>

      {copy === "failed" && (
        <div className="mb-3">
          <p role="alert" data-testid="fixes-copy-error" className="text-sm text-red-600">The browser blocked copying. Select the text below instead.</p>
          <textarea readOnly value={markdown} rows={6} onFocus={(e) => e.currentTarget.select()} aria-label="Fixes as Markdown"
            className="mt-2 w-full rounded-md border border-ink-200 bg-ink-50 px-2.5 py-1.5 font-mono text-xs leading-5 text-ink-700" />
        </div>
      )}

      <ol data-testid={fromTriage ? "job-triage" : undefined} className="space-y-4">
        {items.map((item, i) => (
          <li key={i} data-testid="fixes-item" data-category={item.category} className="flex gap-3 text-sm">
            <span className="w-5 shrink-0 font-mono text-ink-500">{i + 1}</span>
            <div data-testid={fromTriage ? "job-triage-item" : undefined} data-category={fromTriage ? item.category : undefined} className="min-w-0 flex-1">
              <StatusDot tone={CATEGORY[item.category].tone} className="text-xs font-medium text-ink-700">{CATEGORY[item.category].label}</StatusDot>
              <p className="mt-1 font-medium text-ink-900">{item.point}</p>
              {item.evidence && (
                <p className={`mt-1.5 whitespace-pre-wrap break-words rounded-md bg-ink-50 px-2.5 py-1.5 font-mono text-xs leading-5 text-ink-600 ${fromTriage ? "" : "line-clamp-3"}`}>
                  {item.evidence}
                </p>
              )}
              {item.nextStep && (
                <p className="mt-1.5 text-ink-600"><span className="font-medium text-ink-700">Next step:</span> {item.nextStep}</p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
