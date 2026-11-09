"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { BuildingIcon, ChevronRightIcon, LogOutIcon, PlusIcon, Spinner } from "@/components/icons";
import { Avatar, Badge, Button, Field, LoadingScreen, Notice, Wordmark } from "@/components/ui";
import { api, ApiError, postJson } from "@/lib/client/api";

type Org = { id: string; slug: string; name: string; role: "admin" | "viewer" };
type OrgList = { user: { displayName: string; email: string }; organizations: Org[]; currentId: string | null };

const ROLE_LABEL = { admin: "Admin", viewer: "Viewer" } as const;

/**
 * Organization picker, shown after every sign-in. Lists only the organizations
 * this user belongs to; a new user creates their first one here.
 */
export default function OrganizationsPage() {
  const router = useRouter();
  const [data, setData] = useState<OrgList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api<OrgList>("/api/orgs")
      .then(setData)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) router.replace("/login");
        else setError("Could not load your organizations.");
      });
  }, [router]);

  async function open(org: Org) {
    setOpening(org.id);
    setError(null);
    try {
      await postJson("/api/orgs/select", { organizationId: org.id });
      router.push("/workspace");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not open that organization.");
      setOpening(null);
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    setNameError(undefined);
    try {
      await postJson("/api/orgs", { name });
      router.push("/workspace");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setNameError(err.fieldErrors.name);
      } else {
        setError("Could not create the organization.");
      }
      setCreating(false);
    }
  }

  async function signOut() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.replace("/login");
  }

  if (!data && !error) return <LoadingScreen />;

  const orgs = data?.organizations ?? [];
  const isNew = data !== null && orgs.length === 0;
  const createOpen = isNew || showCreate;

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between px-6 py-5">
        <Wordmark />
        <button onClick={signOut} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-ink-600 hover:bg-ink-100 hover:text-ink-900">
          <LogOutIcon className="size-4" /> Sign out
        </button>
      </header>

      <main className="flex flex-1 justify-center px-6 pb-16 pt-6 sm:pt-12">
        <div className="w-full max-w-lg animate-pop-in">
          <h1 className="text-2xl font-semibold tracking-tight text-ink-900">
            {isNew ? "Create your organization" : "Choose an organization"}
          </h1>
          <p className="mt-1.5 text-sm text-ink-500">
            {data && <>Signed in as <span className="font-medium text-ink-700">{data.user.email}</span>. </>}
            {isNew
              ? "Your organization holds your team's studies and results. To join an existing one, ask its admin for an invite."
              : "Each organization's data is kept separate. Pick the one you want to work in."}
          </p>

          {error && <Notice kind="error" className="mt-6">{error}</Notice>}

          {orgs.length > 0 && (
            <ul aria-label="Your organizations" className="mt-6 divide-y divide-ink-100 overflow-hidden rounded-xl border border-ink-200 bg-white shadow-card">
              {orgs.map((o) => (
                <li key={o.id}>
                  <button onClick={() => open(o)} disabled={opening !== null} aria-label={`Open ${o.name}`}
                    className="group flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors hover:bg-ink-50 focus-visible:bg-brand-50 focus-visible:outline-none disabled:cursor-wait">
                    <Avatar name={o.name} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink-900">{o.name}</span>
                      <span className="block truncate text-xs text-ink-500">{o.slug}</span>
                    </span>
                    {data?.currentId === o.id && <Badge tone="success">Current</Badge>}
                    <Badge tone={o.role === "admin" ? "brand" : "neutral"}>{ROLE_LABEL[o.role]}</Badge>
                    {opening === o.id
                      ? <Spinner className="size-4 text-brand-500" />
                      : <ChevronRightIcon className="size-4 text-ink-400 transition-transform group-hover:translate-x-0.5" />}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {createOpen ? (
            <form onSubmit={create} noValidate className="mt-6 rounded-xl border border-ink-200 bg-white p-5 shadow-card">
              <div className="mb-4 flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><BuildingIcon className="size-5" /></span>
                <div>
                  <p className="text-sm font-medium text-ink-900">New organization</p>
                  <p className="text-xs text-ink-500">You will be its Admin and can invite your team later.</p>
                </div>
              </div>
              <Field id="orgName" label="Organization name" placeholder="e.g. Acme Pharma Clinical Ops" autoFocus
                value={name} error={nameError} onChange={(e) => setName(e.target.value)} />
              <div className="mt-4 flex justify-end gap-2">
                {!isNew && <Button type="button" variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>}
                <Button type="submit" loading={creating} loadingText="Creating…">Create organization</Button>
              </div>
            </form>
          ) : (
            <button onClick={() => setShowCreate(true)}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-ink-300 px-4 py-3 text-sm font-medium text-ink-600 transition-colors hover:border-brand-400 hover:bg-brand-50/50 hover:text-brand-700">
              <PlusIcon className="size-4" /> Create a new organization
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
