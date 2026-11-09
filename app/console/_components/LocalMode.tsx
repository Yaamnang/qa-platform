import { connection } from "next/server";
import { Suspense } from "react";
import { isSupabaseEnabled } from "@/lib/server/auth-store";
import { StatusDot } from "./status";

/**
 * Tells whoever is looking that this console is a local one: data in this
 * server's memory, no database behind it. So nobody in a demo wonders whether
 * they are touching production. With STORE=supabase neither piece shows.
 *
 * Server components, used from the console's layouts only. They read the
 * storage switch directly, through the same isSupabaseEnabled() the stores
 * use, so the label and the real backend can never disagree.
 *
 * connection() makes the check run on each request. Without it the page
 * would be prerendered at build time and the label would describe the build
 * machine, not the server that is running. The Suspense boundary keeps that
 * small dynamic part out of the otherwise static page.
 */

async function isLocal(): Promise<boolean> {
  await connection();
  return !isSupabaseEnabled();
}

async function LocalNoticeContent() {
  if (!(await isLocal())) return null;
  return (
    <p role="note" data-testid="console-local-notice"
      className="mt-8 flex w-full max-w-[420px] items-start gap-2.5 rounded-lg border border-ink-200 bg-white px-3.5 py-2.5 text-sm leading-5 text-ink-600">
      <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-amber-500" />
      <span>
        <span className="font-medium text-ink-900">Local demo.</span> Data is kept in memory on this machine and wiped on
        restart. Nothing reaches a database.
      </span>
    </p>
  );
}

async function LocalMarkerContent() {
  if (!(await isLocal())) return null;
  return (
    <span title="Local demo: data is kept in memory and wiped on restart">
      <StatusDot tone="warn" testId="console-local-marker" className="text-xs font-medium text-ink-600">Local</StatusDot>
    </span>
  );
}

/** Under the card of the sign-in, setup and code steps. */
export function LocalNotice() {
  return (
    <Suspense fallback={null}>
      <LocalNoticeContent />
    </Suspense>
  );
}

/** Next to the console's name in the signed-in top bar. */
export function LocalMarker() {
  return (
    <Suspense fallback={null}>
      <LocalMarkerContent />
    </Suspense>
  );
}
