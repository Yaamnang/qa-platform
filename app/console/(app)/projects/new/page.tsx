"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ArrowLeftIcon } from "@/components/icons";
import { Button, buttonStyles, Field, Notice, PageHeader } from "@/components/ui";
import { ApiError, postJson } from "@/lib/client/api";
import type { Project } from "@/lib/console/contract";
import { errorMessage, isSignedOut } from "../../../_components/api";

/**
 * A workspace is a name and a target. The QA account is not asked for here: a
 * run asks for it in the job chat when it reaches the sign-in screen, and can
 * save it on the workspace from there.
 */
type Values = { name: string; targetUrl: string };
type Errors = Partial<Record<keyof Values, string>>;

const EMPTY: Values = { name: "", targetUrl: "" };
const FIELD_IDS: Record<keyof Values, string> = {
  name: "project-name",
  targetUrl: "project-target-url",
};

function validate(v: Values): Errors {
  const errors: Errors = {};
  if (!v.name.trim()) errors.name = "Enter a name.";

  const url = v.targetUrl.trim();
  if (!url) errors.targetUrl = "Enter the target URL.";
  else if (!isHttpUrl(url)) errors.targetUrl = "Enter a full URL that starts with http:// or https://.";
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
      });
      router.push(`/console/projects/${project.id}/probe`);
    } catch (err) {
      if (isSignedOut(err)) return router.replace("/login");
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
          hint="The Probe only reads this site until Full access is turned on."
          onChange={(e) => set("targetUrl", e.target.value)} data-testid="project-target-url" />

        {formError && <Notice kind="error" testId="project-form-error">{formError}</Notice>}

        <div className="flex items-center gap-2 pt-1">
          <Button type="submit" loading={busy} loadingText="Creating…" data-testid="project-submit">Create workspace</Button>
          <Link href="/console" data-testid="project-cancel" className={buttonStyles("ghost")}>Cancel</Link>
        </div>
      </form>
    </>
  );
}
