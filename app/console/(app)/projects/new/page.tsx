"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ArrowLeftIcon, LockIcon } from "@/components/icons";
import { Button, buttonStyles, Field, Notice, PageHeader } from "@/components/ui";
import { ApiError, postJson } from "@/lib/client/api";
import type { Project } from "@/lib/console/contract";
import { errorMessage, isSignedOut } from "../../../_components/api";
import { SecretField } from "../../../_components/SecretField";

type Values = { name: string; targetUrl: string; qaEmail: string; qaPassword: string; qaTotpSecret: string };
type Errors = Partial<Record<keyof Values, string>>;

const EMPTY: Values = { name: "", targetUrl: "", qaEmail: "", qaPassword: "", qaTotpSecret: "" };
const FIELD_IDS: Record<keyof Values, string> = {
  name: "project-name",
  targetUrl: "project-target-url",
  qaEmail: "project-qa-email",
  qaPassword: "project-qa-password",
  qaTotpSecret: "project-qa-totp-secret",
};

const squash = (s: string) => s.replace(/\s+/g, "");

function validate(v: Values): Errors {
  const errors: Errors = {};
  if (!v.name.trim()) errors.name = "Enter a name.";

  const url = v.targetUrl.trim();
  if (!url) errors.targetUrl = "Enter the target URL.";
  else if (!isHttpUrl(url)) errors.targetUrl = "Enter a full URL that starts with http:// or https://.";

  // The QA account fields are optional: a run asks for what is missing when it reaches the sign-in screen.
  const email = v.qaEmail.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.qaEmail = "Enter a valid email address.";
  else if (!email && v.qaPassword) errors.qaEmail = "Enter the email that goes with this password.";

  const secret = squash(v.qaTotpSecret);
  if (!secret) {
    // Left empty: the run asks for a code.
  } else if (/^\d{6}$/.test(secret)) errors.qaTotpSecret = "That is a six-digit code. Enter the setup key instead.";
  else if (!/^[A-Z2-7]+=*$/i.test(secret)) errors.qaTotpSecret = "A setup key only uses the letters A to Z and the digits 2 to 7.";
  return errors;
}

function isHttpUrl(s: string) {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Server field errors, if the API sends any, keyed the same way as the form. */
function serverFieldErrors(err: unknown): Errors {
  if (!(err instanceof ApiError)) return {};
  const out: Errors = {};
  for (const key of Object.keys(FIELD_IDS) as (keyof Values)[]) {
    if (err.fieldErrors[key]) out[key] = err.fieldErrors[key];
  }
  return out;
}

export default function NewProjectPage() {
  const router = useRouter();
  const [values, setValues] = useState<Values>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function set<K extends keyof Values>(key: K, value: string) {
    setValues((v) => ({ ...v, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  }

  function showErrors(found: Errors) {
    setErrors(found);
    const first = (Object.keys(FIELD_IDS) as (keyof Values)[]).find((k) => found[k]);
    if (first) document.getElementById(FIELD_IDS[first])?.focus();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const found = validate(values);
    if (Object.keys(found).length) return showErrors(found);

    setBusy(true);
    try {
      const { project } = await postJson<{ project: Project }>("/api/console/projects", {
        name: values.name.trim(),
        targetUrl: values.targetUrl.trim(),
        qaEmail: values.qaEmail.trim(),
        qaPassword: values.qaPassword,
        qaTotpSecret: squash(values.qaTotpSecret).toUpperCase(),
      });
      // The server has them now. Drop the password and secret before leaving the page.
      setValues(EMPTY);
      router.push(`/console/projects/${project.id}/probe`);
    } catch (err) {
      if (isSignedOut(err)) return router.replace("/console/login");
      const fromServer = serverFieldErrors(err);
      if (Object.keys(fromServer).length) showErrors(fromServer);
      else setFormError(errorMessage(err, "Could not reach the console. Try again."));
      setBusy(false);
    }
  }

  const back = (
    <Link href="/console" data-testid="project-new-back" className="inline-flex items-center gap-1.5 font-medium text-ink-500 hover:text-ink-900">
      <ArrowLeftIcon className="size-3.5" /> Workspaces
    </Link>
  );

  return (
    <>
      <PageHeader eyebrow={back} title="New workspace" />

      <form onSubmit={submit} noValidate autoComplete="off" data-testid="project-form"
        className="max-w-xl space-y-5 rounded-xl border border-ink-200 bg-white p-6">
        <Field id={FIELD_IDS.name} label="Name" required value={values.name} error={errors.name}
          onChange={(e) => set("name", e.target.value)} data-testid="project-name" />
        <Field id={FIELD_IDS.targetUrl} label="Target URL" type="url" inputMode="url" required className="font-mono"
          placeholder="https://staging.example.com" value={values.targetUrl} error={errors.targetUrl}
          hint="Probe is allowed only on hosts on the allow-list. Explore works on any host."
          onChange={(e) => set("targetUrl", e.target.value)} data-testid="project-target-url" />

        <div className="border-t border-ink-200 pt-5">
          <p data-testid="project-qa-optional" className="mb-4 text-xs text-ink-500">
            Optional. Leave these empty and the run asks for them in the job chat when it reaches the sign-in screen.
          </p>
          <Field id={FIELD_IDS.qaEmail} label="QA account email" type="email" className="font-mono"
            value={values.qaEmail} error={errors.qaEmail} hint="A dedicated QA account, never a real person's."
            onChange={(e) => set("qaEmail", e.target.value)} data-testid="project-qa-email" />
        </div>
        <SecretField id={FIELD_IDS.qaPassword} label="QA account password" autoComplete="new-password"
          value={values.qaPassword} error={errors.qaPassword}
          onChange={(e) => set("qaPassword", e.target.value)} testId="project-qa-password" />
        <SecretField id={FIELD_IDS.qaTotpSecret} label="QA account authenticator secret" autoComplete="off" className="font-mono"
          value={values.qaTotpSecret} error={errors.qaTotpSecret} hint="The base32 setup key, not a six-digit code."
          onChange={(e) => set("qaTotpSecret", e.target.value)} testId="project-qa-totp-secret" />
        <p data-testid="project-secrets-note" className="flex items-center gap-1.5 text-xs text-ink-500">
          <LockIcon className="size-3.5 shrink-0" />
          The password and authenticator secret are stored encrypted and never shown again.
        </p>

        {formError && <Notice kind="error" testId="project-form-error">{formError}</Notice>}

        <div className="flex items-center gap-2 pt-1">
          <Button type="submit" loading={busy} loadingText="Creating…" data-testid="project-submit">Create workspace</Button>
          <Link href="/console" data-testid="project-cancel" className={buttonStyles("ghost")}>Cancel</Link>
        </div>
      </form>
    </>
  );
}
