"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, use, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type Me } from "@/lib/client/api";
import { FileIcon, LogOutIcon, SettingsIcon, SwitchIcon, UsersIcon } from "./icons";
import { Avatar, Badge, LoadingScreen, Wordmark } from "./ui";

const MeContext = createContext<Me | null>(null);
export const useMe = () => use(MeContext);

const NAV = [
  { href: "/workspace", label: "Documents", icon: FileIcon, match: (p: string) => p === "/workspace" || p.startsWith("/jobs/") },
  { href: "/team", label: "Team", icon: UsersIcon, match: (p: string) => p === "/team" },
  { href: "/settings", label: "Settings", icon: SettingsIcon, match: (p: string) => p === "/settings" },
];

/**
 * Frame for every signed-in page: sidebar with the current organization,
 * navigation and the user; page content in <main>.
 * Not signed in: go to /login. Signed in but no organization picked: go to /orgs.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    api<Me>("/api/me")
      .then(setMe)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) router.replace("/login");
        else if (e instanceof ApiError && e.code === "no-organization") router.replace("/orgs");
      });
  }, [router]);

  async function signOut() {
    await api("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  if (!me) return <LoadingScreen />;

  return (
    <MeContext value={me}>
      <div className="flex flex-1 flex-col lg:flex-row">
        <aside className="flex shrink-0 flex-col border-b border-ink-200 bg-white lg:fixed lg:inset-y-0 lg:w-64 lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between px-5 py-4 lg:py-5">
            <Wordmark />
            <button onClick={signOut} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-ink-600 hover:bg-ink-100 lg:hidden">
              <LogOutIcon className="size-4" /> Sign out
            </button>
          </div>

          {/* Current organization: always visible, so a user never works in the wrong one. */}
          <div className="mx-3 mb-3 rounded-xl border border-ink-200 bg-ink-50 p-3">
            <div className="flex items-center gap-3">
              <Avatar name={me.tenant.name} />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium uppercase tracking-wide text-ink-500">Organization</p>
                <p data-testid="tenant-badge" className="truncate text-sm font-semibold text-ink-900">
                  <span className="sr-only">Workspace: </span>{me.tenant.name}
                </p>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between">
              <Badge tone={me.role === "admin" ? "brand" : "neutral"}>{me.role === "admin" ? "Admin" : "Viewer"}</Badge>
              <Link href="/orgs" className="inline-flex items-center gap-1 text-xs font-medium text-ink-600 hover:text-brand-700">
                <SwitchIcon className="size-3.5" /> Switch
              </Link>
            </div>
          </div>

          <nav aria-label="Main" className="flex gap-1 px-3 pb-3 lg:flex-1 lg:flex-col">
            {NAV.map(({ href, label, icon: NavIcon, match }) => {
              const active = match(pathname);
              return (
                <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined}
                  className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    active ? "bg-brand-50 text-brand-700" : "text-ink-600 hover:bg-ink-100 hover:text-ink-900"}`}>
                  <NavIcon className={`size-4 ${active ? "text-brand-600" : "text-ink-400"}`} />
                  {label}
                </Link>
              );
            })}
          </nav>

          <div className="hidden border-t border-ink-100 p-3 lg:block">
            <div className="flex items-center gap-3 rounded-lg px-2 py-2">
              <Avatar name={me.displayName} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink-900">{me.displayName}</p>
                <p className="truncate text-xs text-ink-500">{me.email}</p>
              </div>
            </div>
            <button onClick={signOut}
              className="mt-1 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-ink-600 hover:bg-ink-100 hover:text-ink-900">
              <LogOutIcon className="size-4 text-ink-400" /> Sign out
            </button>
          </div>
        </aside>

        <main className="w-full flex-1 lg:pl-64">
          <div className="mx-auto max-w-5xl px-6 py-8 lg:px-10 lg:py-10">{children}</div>
        </main>
      </div>
    </MeContext>
  );
}
