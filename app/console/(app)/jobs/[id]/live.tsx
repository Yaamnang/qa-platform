"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { LockIcon } from "@/components/icons";
import type { Job, LiveFrameMeta, TriageItem } from "@/lib/console/contract";

const POLL_MS = 500;

export type LiveFrame = { meta: LiveFrameMeta | null; src: string | null };

/**
 * The run's latest live view frame. While the job is active the meta is polled
 * every 500 ms and the image is fetched only when its seq changes. The image is
 * kept as an object URL, so the last frame stays on screen after the job ends,
 * when the server has already dropped it.
 */
export function useLiveFrame(jobId: string, active: boolean): LiveFrame {
  const [frame, setFrame] = useState<LiveFrame>({ meta: null, src: null });
  const current = useRef<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let seq = 0;
    const poll = async () => {
      try {
        const r = await api<{ frame: LiveFrameMeta | null }>(`/api/console/jobs/${jobId}/frame/meta`);
        const meta = r.frame;
        if (!stopped && meta && meta.seq !== seq) {
          const res = await fetch(`/api/console/jobs/${jobId}/frame?seq=${meta.seq}`, { cache: "no-store" });
          // A newer frame may have landed between the two requests. Its box would not match, so wait for the next tick.
          if (!stopped && res.status === 200 && res.headers.get("x-live-seq") === String(meta.seq)) {
            const blob = await res.blob();
            if (!stopped) {
              seq = meta.seq;
              const src = URL.createObjectURL(blob);
              if (current.current) URL.revokeObjectURL(current.current);
              current.current = src;
              setFrame({ meta, src });
            }
          }
        }
      } catch {
        // The live view is a nicety: a missed frame is retried on the next tick.
      }
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [jobId, active]);

  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current);
    },
    [],
  );

  return frame;
}

const pct = (n: number, of: number) => `${Math.min(100, Math.max(0, (n / of) * 100))}%`;

/** The host part of a URL for the tab title, or the raw text if it does not parse. */
function hostOf(url: string) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** What the QA browser shows, drawn as a browser window: a tab, the address bar, then the page with the current step and its target. */
export function LivePanel({ frame, finished, className = "" }: { frame: LiveFrame; finished: boolean; className?: string }) {
  const { meta, src } = frame;
  const vw = meta?.viewport.width ?? 0;
  const vh = meta?.viewport.height ?? 0;
  const box = meta?.box && vw > 0 && vh > 0 ? meta.box : null;
  const url = meta?.url ?? "";
  const secure = url.startsWith("https://");

  return (
    <section aria-label="Live view" data-testid="job-live" data-seq={meta?.seq ?? 0}
      className={`overflow-hidden rounded-xl border border-ink-200 bg-white ${className}`}>
      {/* Tab strip: window dots, one tab with the host, run state on the right. */}
      <div className="flex items-end gap-3 bg-ink-100 px-3 pt-2">
        <div aria-hidden="true" className="flex gap-1.5 self-center pb-2">
          <span className="size-2.5 rounded-full bg-ink-300" />
          <span className="size-2.5 rounded-full bg-ink-300" />
          <span className="size-2.5 rounded-full bg-ink-300" />
        </div>
        <div className="flex min-w-0 max-w-64 items-center rounded-t-lg bg-white px-3 py-1.5 text-xs text-ink-700">
          <span className="truncate">{url ? hostOf(url) : "New tab"}</span>
        </div>
        <div className="ml-auto flex items-center gap-1.5 self-center pb-2 text-xs">
          {finished ? (
            <span className="text-ink-500">Finished</span>
          ) : (
            <>
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand-500 opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-brand-500" />
              </span>
              <span className="font-medium text-ink-700">Live</span>
            </>
          )}
        </div>
      </div>

      {/* Address bar. */}
      <div className="border-b border-ink-200 px-3 py-2">
        <div className="flex items-center gap-2 rounded-full bg-ink-50 px-3 py-1.5">
          {secure && <LockIcon className="size-3.5 shrink-0 text-ink-500" />}
          <span data-testid="job-live-url" title={meta?.url} className={`min-w-0 flex-1 truncate font-mono text-xs ${url ? "text-ink-700" : "text-ink-400"}`}>
            {url || "about:blank"}
          </span>
        </div>
      </div>

      {src && meta ? (
        <div className="relative bg-ink-50">
          {/* An object URL of a JPEG the run sent: next/image has nothing to optimise here. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img data-testid="job-live-frame" src={src} alt="What the QA browser shows" width={vw || undefined} height={vh || undefined}
            className={`block h-auto w-full ${finished ? "opacity-90" : ""}`} />
          {box && !finished && (
            <div data-testid="job-live-box" aria-hidden="true"
              className="pointer-events-none absolute rounded-sm bg-brand-500/10 outline-2 outline-brand-500"
              style={{ left: pct(box.x, vw), top: pct(box.y, vh), width: pct(box.width, vw), height: pct(box.height, vh) }} />
          )}
          {finished && (
            <span data-testid="job-live-finished"
              className="absolute right-3 top-3 rounded-md border border-ink-200 bg-white/90 px-2 py-1 text-xs font-medium text-ink-700">
              Finished
            </span>
          )}
          {meta.label && (
            <div data-testid="job-live-caption" className="absolute inset-x-0 bottom-0 truncate bg-ink-900/75 px-4 py-1.5 text-xs text-white">
              {meta.label}
            </div>
          )}
        </div>
      ) : (
        <div data-testid="job-live-empty" className="flex aspect-video items-center justify-center bg-ink-50 text-sm text-ink-500">
          {finished ? "No frames were sent." : "Waiting for the browser."}
        </div>
      )}
    </section>
  );
}

/** A finished job in a few plain sentences. Advisory: the verdict and proposals below are the record. */
export function JobSummaryPanel({ summary }: { summary: NonNullable<Job["summary"]> }) {
  return (
    <section aria-label="Summary" data-testid="job-summary" data-by={summary.by}
      className="mb-6 rounded-xl border border-ink-200 bg-white px-5 py-4">
      <div className="mb-1.5 flex items-baseline gap-2 text-sm">
        <span className="font-medium text-ink-700">Summary</span>
        {summary.by === "claude" && <span data-testid="job-summary-by" className="text-xs text-ink-500">by Claude</span>}
      </div>
      <p data-testid="job-summary-text" className="text-sm leading-6 text-ink-700">{summary.text}</p>
      {summary.triage && summary.triage.length > 0 && (
        <ol data-testid="job-triage" className="mt-4 space-y-3 border-t border-ink-200 pt-4">
          {summary.triage.map((item, i) => (
            <li key={i} data-testid="job-triage-item" data-category={item.category} className="text-sm">
              <div className="flex items-start gap-3">
                <span className={`mt-0.5 inline-flex shrink-0 items-center gap-1.5 text-xs font-medium ${TRIAGE[item.category].text}`}>
                  <span aria-hidden="true" className={`size-2 rounded-full ${TRIAGE[item.category].dot}`} />
                  <span className="w-20">{TRIAGE[item.category].label}</span>
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink-900">{item.point}</p>
                  <p className="mt-1 break-words rounded-md bg-ink-50 px-2.5 py-1.5 font-mono text-xs leading-5 text-ink-600">{item.evidence}</p>
                  <p className="mt-1 text-ink-600"><span className="font-medium text-ink-700">Next:</span> {item.nextStep}</p>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Where the fix belongs. Red for a product bug, amber for the run's own setup, grey for the check itself. */
const TRIAGE: Record<TriageItem["category"], { label: string; dot: string; text: string }> = {
  product: { label: "Product bug", dot: "bg-red-500", text: "text-red-600" },
  environment: { label: "Environment", dot: "bg-amber-500", text: "text-amber-900" },
  test: { label: "Test issue", dot: "bg-ink-400", text: "text-ink-600" },
};
