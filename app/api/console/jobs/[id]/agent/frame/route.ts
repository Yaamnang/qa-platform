import { NextResponse, type NextRequest } from "next/server";
import type { LiveFrameMeta } from "@/lib/console/contract";
import { hasOpenLink } from "@/lib/console/server/chat";
import { jsonError, requireJobToken } from "@/lib/console/server/http";
import { MAX_FRAME_BYTES, putFrame } from "@/lib/console/server/live-frames";

// The latest live view frame from the run (qa/lib/live-view.ts). Job token only.
// Kept in memory, one per job, replaced by the next one.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const denied = requireJobToken(req, id);
  if (denied) return denied;

  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_FRAME_BYTES) return jsonError(413, "Frame too large.");
  const bytes = new Uint8Array(await req.arrayBuffer().catch(() => new ArrayBuffer(0)));
  if (bytes.byteLength > MAX_FRAME_BYTES) return jsonError(413, "Frame too large.");
  if (bytes.byteLength < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return jsonError(400, "Send a JPEG.");

  const viewport = size(json(req.headers.get("x-live-viewport")));
  if (!viewport) return jsonError(400, "Send X-Live-Viewport.");

  // The job may have finished while the body was arriving. Its frame was dropped then and must stay dropped.
  if (!hasOpenLink(id)) return jsonError(404, "Not found.");
  const meta = putFrame(id, bytes, {
    url: text(req.headers.get("x-live-url"), 2000) ?? "",
    label: text(req.headers.get("x-live-label"), 200),
    box: box(json(req.headers.get("x-live-box"))),
    viewport,
  });
  return NextResponse.json({ ok: true, seq: meta.seq });
}

function text(raw: string | null, max: number): string | null {
  if (!raw) return null;
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    // Not encoded: keep it as sent.
  }
  value = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  return value || null;
}

function json(raw: string | null): unknown {
  if (!raw || raw.length > 200) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 100_000;

function size(value: unknown): LiveFrameMeta["viewport"] | null {
  const v = value as { width?: unknown; height?: unknown } | null;
  if (!v || !finite(v.width) || !finite(v.height) || v.width <= 0 || v.height <= 0) return null;
  return { width: v.width, height: v.height };
}

function box(value: unknown): LiveFrameMeta["box"] {
  const b = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
  if (!b || !finite(b.x) || !finite(b.y) || !finite(b.width) || !finite(b.height) || b.width <= 0 || b.height <= 0) return null;
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}
