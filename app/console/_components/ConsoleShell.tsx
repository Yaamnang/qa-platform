"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, Suspense, useContext, useEffect, useState, type ComponentType, type Dispatch, type ReactNode, type SetStateAction, type SVGProps } from "react";
import { ActivityIcon, ClockIcon, ExternalLinkIcon, GitBranchIcon, GridIcon, LogOutIcon } from "@/components/icons";
import { Button } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { Employee } from "@/lib/console/contract";
import { errorMessage, isSignedOut } from "./api";
import { ConsoleName } from "./ConsoleName";
import { LoadError } from "./states";

/**
 * Frame for every signed-in console page: an icon rail on the left, a top bar
 * with the console's name, the signed-in employee and sign out. Not signed in:
 * go to /login.
 *
 * marker sits next to the name: the "Local" label from LocalMode.tsx, which
 * renders nothing when the console runs on Supabase. Inside a workspace the
 * top bar then shows "/ <workspace name>" and a link to its target, which
 * WorkspaceFrame hands up through useSetTopBarCrumb.
 *
 * The page always renders, even while the session loads. Next prerenders this
 * shell with no session and validates every page under it, so holding the page
 * back here would hide it from that check. Each page loads its own data and
 * sends a signed-out visitor to /login itself. The error screen below replaces
 * the page only after the session request has actually failed in the browser.
 */
/** What the top bar shows after the console name: the open workspace. */
export type TopBarCrumb = { name: string; url: string };

const CrumbSetterContext = createContext<Dispatch<SetStateAction<TopBarCrumb | null>>>(() => {});

/** Sets or clears the top bar's workspace crumb. The setter is stable, so it is safe in effect deps. */
export function useSetTopBarCrumb() {
  return useContext(CrumbSetterContext);
}

export function ConsoleShell({ children, marker }: { children: ReactNode; marker?: ReactNode }) {
  const router = useRouter();
  const [crumb, setCrumb] = useState<TopBarCrumb | null>(null);
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
        if (isSignedOut(err)) router.replace("/login");
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
    router.replace("/login");
  }

  if (error) {
    return (
      <main className="mx-auto w-full max-w-md flex-1 px-6 py-24">
        <ConsoleName className="mb-6 block" />
        <LoadError testId="console-load-error" message={error} onRetry={() => { setError(null); setAttempt((n) => n + 1); }} />
        <Link href="/login" data-testid="console-load-error-sign-in" className="mt-4 inline-block text-sm font-medium text-brand-600 hover:text-brand-700">
          Sign in again
        </Link>
      </main>
    );
  }
  return (
    <CrumbSetterContext value={setCrumb}>
      {/* The rail reads the URL, which is unknown while a dynamic route prerenders, so it waits behind its own boundary. */}
      <Suspense fallback={<Rail pathname={null} />}>
        <RailForPath />
      </Suspense>
      {/* Header and page sit to the right of the rail, which is w-14 (56px). */}
      <div className="flex flex-1 flex-col pl-14">
        <header className="sticky top-0 z-20 border-b border-ink-200 bg-white/95 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-[1680px] items-center gap-6 px-6">
            <div className="flex min-w-0 items-center gap-3">
              <Link href="/console" data-testid="console-home" className="shrink-0 rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-500">
                <ConsoleName />
              </Link>
              {marker}
              {/* Reads the URL for its placeholder, so it waits behind a boundary like the rail. */}
              <Suspense fallback={null}>
                <CrumbForPath crumb={crumb} />
              </Suspense>
            </div>
            <div className="ml-auto flex min-w-0 items-center gap-3">
              {employee ? (
                <>
                  <p data-testid="console-employee" className="min-w-0 text-right leading-tight">
                    <span className="block truncate text-sm font-medium text-ink-900">{employee.displayName}</span>
                    <span className="hidden truncate text-xs text-ink-500 sm:block">{employee.email}</span>
                  </p>
                  <Button variant="ghost" size="sm" onClick={signOut} loading={signingOut} data-testid="console-sign-out" className="shrink-0 whitespace-nowrap"
                    icon={<LogOutIcon className="size-4" />}>
                    Sign out
                  </Button>
                </>
              ) : (
                // Holds the space of the name and sign-out until the session loads.
                <span aria-busy="true" className="h-8 w-44 animate-pulse rounded-md bg-ink-100">
                  <span className="sr-only">Loading your session</span>
                </span>
              )}
            </div>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1680px] flex-1 px-6 py-5 lg:py-6">{children}</main>
      </div>
    </CrumbSetterContext>
  );
}

/** The workspace id in /console/projects/<id>/..., or null outside a workspace. "new" is the create page, not a workspace. */
function workspaceIdFrom(pathname: string | null): string | null {
  const match = pathname?.match(/^\/console\/projects\/([^/]+)/);
  return match && match[1] !== "new" ? match[1] : null;
}

/** "/ name [link]" in the top bar. Inside a workspace whose data has not loaded yet, a pulse holds the place. */
function CrumbForPath({ crumb }: { crumb: TopBarCrumb | null }) {
  if (!workspaceIdFrom(usePathname())) return null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span aria-hidden="true" className="text-ink-300">/</span>
      {crumb ? (
        <>
          <span data-testid="topbar-workspace" className="truncate text-sm font-semibold text-ink-900">{crumb.name}</span>
          <a href={crumb.url} target="_blank" rel="noreferrer" data-testid="project-target" title={crumb.url} aria-label={`Open ${crumb.url}`}
            className="shrink-0 rounded-md p-1 text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500">
            <ExternalLinkIcon className="size-4" />
          </a>
        </>
      ) : (
        <span aria-busy="true" className="h-5 w-40 animate-pulse rounded bg-ink-100"><span className="sr-only">Loading workspace</span></span>
      )}
    </div>
  );
}

/** The sections of one workspace, shown in the rail while the URL is inside it. */
const WORKSPACE_SECTIONS = [
  { slug: "probe", label: "Probe", Icon: ActivityIcon },
  { slug: "github", label: "GitHub", Icon: GitBranchIcon },
  { slug: "history", label: "History", Icon: ClockIcon },
] as const;

function RailForPath() {
  return <Rail pathname={usePathname()} />;
}

/**
 * The left icon rail on every signed-in page. Workspaces is always there.
 * Inside a workspace (/console/projects/<id>/...) its sections follow.
 * pathname is null while the URL is not known yet: only Workspaces shows, none current.
 */
function Rail({ pathname }: { pathname: string | null }) {
  const workspaceId = workspaceIdFrom(pathname);
  const onList = pathname === "/console" || pathname === "/console/projects/new";

  return (
    <aside className="fixed inset-y-0 left-0 z-30 flex w-14 flex-col items-center gap-1 border-r border-ink-200 bg-white py-2">
      <nav aria-label="Console" className="flex flex-col items-center gap-1">
        <RailLink href="/console" label="Workspaces" Icon={GridIcon} current={onList} testId="rail-workspaces" />
      </nav>
      {workspaceId && (
        <nav aria-label="Workspace" data-testid="workspace-nav" className="mt-2 flex flex-col items-center gap-1 border-t border-ink-200 pt-3">
          {WORKSPACE_SECTIONS.map((s) => {
            const href = `/console/projects/${workspaceId}/${s.slug}`;
            const current = pathname === href || (pathname?.startsWith(`${href}/`) ?? false);
            return <RailLink key={s.slug} href={href} label={s.label} Icon={s.Icon} current={current} testId={`workspace-nav-${s.slug}`} />;
          })}
        </nav>
      )}
    </aside>
  );
}

function RailLink({ href, label, Icon, current, testId }: {
  href: string;
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  current: boolean;
  testId: string;
}) {
  return (
    <Link href={href} aria-label={label} title={label} aria-current={current ? "page" : undefined} data-testid={testId}
      className={`flex size-10 items-center justify-center rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 ${
        current ? "bg-brand-50 text-brand-700" : "text-ink-500 hover:bg-ink-100 hover:text-ink-900"
      }`}>
      <Icon className="size-5" />
      <span className="sr-only">{label}</span>
    </Link>
  );
}
