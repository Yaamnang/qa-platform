"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { LogOutIcon } from "@/components/icons";
import { Button, LoadingScreen } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { Employee } from "@/lib/console/contract";
import { errorMessage, isSignedOut } from "./api";
import { ConsoleName } from "./ConsoleName";
import { LoadError } from "./states";

/**
 * Frame for every signed-in console page: a top bar with the console's name,
 * the signed-in employee and sign out. Not signed in: go to /console/login.
 *
 * marker sits next to the name: the "Local" label from LocalMode.tsx, which
 * renders nothing when the console runs on Supabase.
 */
export function ConsoleShell({ children, marker }: { children: ReactNode; marker?: ReactNode }) {
  const router = useRouter();
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<{ employee: Employee }>("/api/console/me")
      .then((r) => !cancelled && setEmployee(r.employee))
      .catch((err) => {
        if (cancelled) return;
        if (isSignedOut(err)) router.replace("/console/login");
        else setError(`Could not load your session. ${errorMessage(err, "The console did not answer.")}`);
      });
    return () => {
      cancelled = true;
    };
  }, [router, attempt]);

  async function signOut() {
    setSigningOut(true);
    // Leave even if the request fails: the session cookie expires on its own.
    await api("/api/console/auth/logout", { method: "POST" }).catch(() => {});
    router.replace("/console/login");
  }

  if (error) {
    return (
      <main className="mx-auto w-full max-w-md flex-1 px-6 py-24">
        <ConsoleName className="mb-6 block" />
        <LoadError testId="console-load-error" message={error} onRetry={() => { setError(null); setAttempt((n) => n + 1); }} />
        <Link href="/console/login" data-testid="console-load-error-sign-in" className="mt-4 inline-block text-sm font-medium text-brand-600 hover:text-brand-700">
          Sign in again
        </Link>
      </main>
    );
  }
  if (!employee) return <LoadingScreen label="Loading…" />;

  return (
    <>
      <header className="sticky top-0 z-20 border-b border-ink-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-6 px-6">
          <div className="flex items-center gap-3">
            <Link href="/console" data-testid="console-home" className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-500">
              <ConsoleName />
            </Link>
            {marker}
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-3">
            <p data-testid="console-employee" className="min-w-0 text-right leading-tight">
              <span className="block truncate text-sm font-medium text-ink-900">{employee.displayName}</span>
              <span className="hidden truncate text-xs text-ink-500 sm:block">{employee.email}</span>
            </p>
            <Button variant="ghost" size="sm" onClick={signOut} loading={signingOut} data-testid="console-sign-out" className="shrink-0 whitespace-nowrap"
              icon={<LogOutIcon className="size-4" />}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8 lg:py-10">{children}</main>
    </>
  );
}
