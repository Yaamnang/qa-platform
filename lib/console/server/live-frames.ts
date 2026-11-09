import "server-only";
import type { LiveFrameMeta } from "../contract";

/**
 * The live view's latest frame per job (see qa/lib/live-view.ts).
 *
 * Only the newest frame is kept, in this process's memory, and it is dropped
 * when the job finishes (runner.ts, next to closeLink). Frames are never
 * written to disk or the database. Password and code inputs are masked by the
 * run before the screenshot leaves the browser.
 */

export const MAX_FRAME_BYTES = 600 * 1024;

type Stored = { bytes: Uint8Array; meta: LiveFrameMeta };

const g = globalThis as unknown as { __consoleLiveFrames?: Map<string, Stored> };
const frames: Map<string, Stored> = (g.__consoleLiveFrames ??= new Map());

export function putFrame(jobId: string, bytes: Uint8Array, meta: Omit<LiveFrameMeta, "seq" | "at">): LiveFrameMeta {
  const seq = (frames.get(jobId)?.meta.seq ?? 0) + 1;
  const stored: Stored = { bytes, meta: { ...meta, seq, at: Date.now() } };
  frames.set(jobId, stored);
  return stored.meta;
}

export function getFrame(jobId: string): Stored | null {
  return frames.get(jobId) ?? null;
}

export function dropFrame(jobId: string): void {
  frames.delete(jobId);
}
