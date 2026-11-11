"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button, Field, Notice, Wordmark, formatDate } from "@/components/ui";
import { ApiError, api, postJson } from "@/lib/client/api";
import { errorMessage } from "../console/_components/api";
import { SecretField } from "../console/_components/SecretField";
import { ListSkeleton, LoadError } from "../console/_components/states";
import { StatusDot } from "../console/_components/status";

type Employee = { id: string; email: string; displayName: string; totpConfirmed: boolean; createdAt: number };
type NewPassword = { email: string; password: string };

/**
 * The admin portal: sign in with the fixed admin account, then add, remove
 * or reset the QA console's employees. The server side is app/api/admin and
 * lib/admin/auth.ts.
 */
export function AdminPortal() {
  const [view, setView] = useState<"loading" | "signed-out" | "error" | "ready">("loading");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    try {
      const { employees } = await api<{ employees: Employee[] }>("/api/admin/employees");
      setEmployees(employees);
      setView("ready");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return setView("signed-out");
      setLoadError(errorMessage(err, "Could not reach the server."));
      setView("error");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- first load
    void load();
  }, [load]);

  async function signOut() {
    await postJson("/api/admin/logout", {}).catch(() => {});
    setView("signed-out");
  }

  if (view === "signed-out") return <AdminSignIn onSignedIn={() => void load()} />;

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-ink-200">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <Wordmark tone="light" className="-ml-3 h-8" />
            <span aria-hidden="true" className="h-5 w-px bg-ink-200" />
            <span className="text-sm font-medium text-brand-600">Admin</span>
          </div>
          {view === "ready" && (
            <Button variant="ghost" size="sm" onClick={signOut} data-testid="admin-sign-out">Sign out</Button>
          )}
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-10">
        {view === "loading" && <ListSkeleton label="Loading employees" />}
        {view === "error" && <LoadError message={loadError} onRetry={() => void load()} testId="admin-load-error" />}
        {view === "ready" && <Employees employees={employees} reload={load} onSignedOut={() => setView("signed-out")} />}
      </main>
    </div>
  );
}

function AdminSignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/admin/login", { email, password, code });
      onSignedIn();
    } catch (err) {
      setError(errorMessage(err, "Could not reach the server. Try again."));
      setPassword("");
      setCode("");
      setBusy(false);
    }
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-[400px] animate-pop-in">
        <div className="mb-10 flex items-center gap-3">
          <Wordmark tone="light" className="-ml-3 h-8" />
          <span aria-hidden="true" className="h-5 w-px bg-ink-200" />
          <span className="text-sm font-medium text-brand-600">Admin</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Admin sign in</h1>
        <form onSubmit={submit} className="mt-8 space-y-5">
          <Field id="admin-email" label="Admin email" type="email" autoComplete="username" required autoFocus
            value={email} onChange={(e) => setEmail(e.target.value)} data-testid="admin-email" />
          <SecretField id="admin-password" label="Password" autoComplete="current-password" required testId="admin-password"
            placeholder="Enter the admin password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <Field id="admin-code" label="Code from your phone" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6}
            required placeholder="000000" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            className="font-mono tracking-[0.3em]" data-testid="admin-code" />
          {error && <Notice kind="error" testId="admin-error">{error}</Notice>}
          <Button type="submit" size="lg" className="w-full" loading={busy} loadingText="Checking…" data-testid="admin-submit">
            Sign in
          </Button>
        </form>
      </div>
    </main>
  );
}

function Employees({ employees, reload, onSignedOut }: { employees: Employee[]; reload: () => Promise<void>; onSignedOut: () => void }) {
  const [shown, setShown] = useState<NewPassword | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Any action can find the admin session expired (30 minutes).
  function failed(err: unknown, fallback: string) {
    if (err instanceof ApiError && err.status === 401) return onSignedOut();
    setError(errorMessage(err, fallback));
  }

  async function reset(e: Employee) {
    setBusyId(e.id);
    setError(null);
    try {
      setShown(await postJson<NewPassword>(`/api/admin/employees/${e.id}/reset`, {}));
      await reload();
    } catch (err) {
      failed(err, "Could not reset the password.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(e: Employee) {
    setBusyId(e.id);
    setError(null);
    try {
      await api(`/api/admin/employees/${e.id}`, { method: "DELETE" });
      setConfirming(null);
      await reload();
    } catch (err) {
      failed(err, "Could not remove the employee.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-10">
      {shown && <ShownOnce value={shown} onDone={() => setShown(null)} />}

      <section aria-labelledby="employees-heading">
        <h1 id="employees-heading" className="text-xl font-semibold tracking-tight text-ink-900">
          Employees <span className="font-mono text-sm font-normal text-ink-500">{employees.length}</span>
        </h1>
        {error && <Notice kind="error" testId="admin-action-error" className="mt-4">{error}</Notice>}
        {employees.length === 0 ? (
          <p data-testid="admin-empty" className="mt-4 text-sm text-ink-500">No employees. Nobody can sign in to the console until one is added.</p>
        ) : (
          <ul className="mt-4 divide-y divide-ink-200 rounded-xl border border-ink-200 bg-white" data-testid="admin-employees">
            {employees.map((e) => (
              <li key={e.id} data-testid="admin-employee" className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink-900">{e.displayName}</p>
                  <p className="truncate font-mono text-xs text-ink-500">{e.email}</p>
                </div>
                <StatusDot tone={e.totpConfirmed ? "pass" : "idle"} className="w-36 text-xs text-ink-600">
                  {e.totpConfirmed ? "Authenticator set up" : "Not signed in yet"}
                </StatusDot>
                <span className="hidden w-40 font-mono text-xs text-ink-500 md:block">{formatDate(e.createdAt)}</span>
                {confirming === e.id ? (
                  <div className="flex items-center gap-2">
                    <Button variant="danger" size="sm" loading={busyId === e.id} onClick={() => remove(e)} data-testid="admin-remove-confirm">
                      Remove
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>Cancel</Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <Button variant="secondary" size="sm" loading={busyId === e.id} onClick={() => reset(e)} data-testid="admin-reset">
                      Reset password
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirming(e.id)} data-testid="admin-remove">Remove</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <AddEmployee onAdded={async (added) => { setShown(added); await reload(); }} onSignedOut={onSignedOut} />
    </div>
  );
}

function AddEmployee({ onAdded, onSignedOut }: { onAdded: (added: NewPassword) => Promise<void>; onSignedOut: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const added = await postJson<NewPassword>("/api/admin/employees", { email, name });
      setEmail("");
      setName("");
      await onAdded(added);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) setFieldErrors(err.fieldErrors);
      else setError(errorMessage(err, "Could not add the employee."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="add-heading">
      <h2 id="add-heading" className="text-base font-semibold text-ink-900">Add employee</h2>
      <form onSubmit={submit} noValidate className="mt-4 grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-start">
        <Field id="add-email" label="Work email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
          placeholder="someone@eclypse.ai" error={fieldErrors.email} data-testid="admin-add-email" />
        <Field id="add-name" label="Name" required value={name} onChange={(e) => setName(e.target.value)}
          placeholder="Their name" error={fieldErrors.name} data-testid="admin-add-name" />
        <Button type="submit" className="sm:mt-[26px]" loading={busy} loadingText="Adding…" data-testid="admin-add-submit">Add</Button>
      </form>
      {error && <Notice kind="error" testId="admin-add-error" className="mt-4">{error}</Notice>}
    </section>
  );
}

/** A new password, shown once. Only its hash is stored, so closing this loses it. */
function ShownOnce({ value, onDone }: { value: NewPassword; onDone: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value.password);
    setCopied(true);
  }

  return (
    <section role="status" data-testid="admin-new-password" className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
      <p className="text-sm text-emerald-800">
        Password for <span className="font-mono">{value.email}</span>. Shown once. They set up their authenticator on first sign-in.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code data-testid="admin-new-password-value" className="select-all rounded-lg border border-ink-200 bg-ink-50 px-3 py-2 font-mono text-sm text-ink-900">
          {value.password}
        </code>
        <Button variant="secondary" size="sm" onClick={copy} data-testid="admin-copy">{copied ? "Copied" : "Copy"}</Button>
        <Button variant="ghost" size="sm" onClick={onDone} data-testid="admin-done">Done</Button>
      </div>
    </section>
  );
}
