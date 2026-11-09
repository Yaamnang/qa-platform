import { useEffect, useState } from "react";
import { formatDate } from "@/components/ui";
import type { Job } from "@/lib/console/contract";

/** 42s, 1m 03s, 2h 05m. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "4 min ago" for the last week, the full date after that. */
export function formatAgo(ms: number, now: number): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return d === 1 ? "yesterday" : `${d} days ago`;
  return formatDate(ms);
}

/** When a job last did something: finished, else started, else queued. */
export const jobTime = (job: Job) => job.finishedAt ?? job.startedAt ?? job.createdAt;

/** Run time of a finished job, or null while it has not finished. */
export function jobDuration(job: Job): number | null {
  return job.finishedAt === null ? null : job.finishedAt - (job.startedAt ?? job.createdAt);
}

/** The current time, refreshed every `intervalMs`. 0 until the first tick, which comes straight after mount. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [intervalMs]);
  return now;
}
