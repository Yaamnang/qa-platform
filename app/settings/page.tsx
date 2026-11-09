"use client";

import { useEffect, useState, type FormEvent } from "react";
import { AppShell, useMe } from "@/components/AppShell";
import { LockIcon, ShieldIcon } from "@/components/icons";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";

type Settings = { displayName: string; notificationEmail: string };

export default function SettingsPage() {
  return (
    <AppShell>
      <SettingsForm />
    </AppShell>
  );
}

function SettingsForm() {
  const me = useMe();
  const [values, setValues] = useState<Settings | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<Settings>("/api/settings").then(setValues).catch(() => setStatus({ kind: "error", text: "Could not load settings." }));
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!values) return;
    setSaving(true);
    setStatus(null);
    setFieldErrors({});
    try {
      const saved = await api<Settings>("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values),
      });
      setValues(saved);
      setStatus({ kind: "success", text: "Settings saved." });
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        setStatus({ kind: "error", text: err.message });
      } else {
        setStatus({ kind: "error", text: "Could not save settings." });
      }
    } finally {
      setSaving(false);
    }
  }

  const bind = (key: keyof Settings) => ({
    value: values?.[key] ?? "",
    error: fieldErrors[key],
    onChange: (e: { target: { value: string } }) => values && setValues({ ...values, [key]: e.target.value }),
  });

  return (
    <>
      <PageHeader title="Settings" description="Your profile and how you sign in." />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Card title="Profile" description="How you appear to your team, and where notifications go." className="mb-0">
          {!values ? (
            <div className="space-y-4" aria-busy="true">
              {[0, 1].map((i) => <div key={i} className="h-16 animate-pulse rounded-lg bg-ink-100" />)}
            </div>
          ) : (
            <form onSubmit={save} noValidate className="space-y-5">
              {status && <Notice kind={status.kind}>{status.text}</Notice>}
              <Field id="displayName" label="Display name" {...bind("displayName")} />
              <Field id="notificationEmail" label="Notification email" type="email"
                hint="Analysis results and security alerts are sent here." {...bind("notificationEmail")} />
              <div className="flex justify-end border-t border-ink-100 pt-5">
                <Button type="submit" loading={saving} loadingText="Saving…">Save changes</Button>
              </div>
            </form>
          )}
        </Card>

        <div className="space-y-6">
          <Card title="Account" className="mb-0">
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-xs text-ink-500">Sign-in email</dt>
                <dd className="truncate font-medium text-ink-900">{me?.email}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-500">Organization</dt>
                <dd className="font-medium text-ink-900">{me?.tenant.name}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-500">Role</dt>
                <dd className="mt-0.5"><Badge tone={me?.role === "admin" ? "brand" : "neutral"}>{me?.role === "admin" ? "Admin" : "Viewer"}</Badge></dd>
              </div>
            </dl>
          </Card>
          <Card title="Security" className="mb-0">
            <ul className="space-y-3 text-sm">
              <li className="flex items-start gap-2.5">
                <ShieldIcon className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                <span><span className="font-medium text-ink-900">Two-step sign-in is on.</span>
                  <span className="block text-xs text-ink-500">Password plus authenticator code.</span></span>
              </li>
              <li className="flex items-start gap-2.5">
                <LockIcon className="mt-0.5 size-4 shrink-0 text-ink-400" />
                <span className="text-xs text-ink-500">Sessions end after 8 hours, or when you sign out.</span>
              </li>
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
