"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { AuthLayout, codeInputStyles } from "@/components/AuthLayout";
import { CheckIcon, CopyIcon, Spinner } from "@/components/icons";
import { Button, Notice } from "@/components/ui";
import { api, ApiError, postJson } from "@/lib/client/api";

type Setup = { email: string; secret: string; otpauthUri: string; qrSvg: string };

/**
 * Sign-up: connect an authenticator app.
 * Scan the QR code (or type the key), then enter the first code to prove it works.
 * Until this is done the account cannot sign in.
 */
export default function AuthenticatorSetupPage() {
  const router = useRouter();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api<Setup>("/api/auth/setup")
      .then(setSetup)
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Could not start authenticator setup."));
  }, []);

  async function confirm(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { next } = await postJson<{ next: string }>("/api/auth/setup", { code });
      router.replace(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
      setCode("");
      setBusy(false);
    }
  }

  async function copySecret() {
    if (!setup) return;
    await navigator.clipboard.writeText(setup.secret).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <AuthLayout
      title="Set up your authenticator"
      subtitle="Every sign-in asks for a code from this app, so only you can get in."
      footer={<Link href="/login" className="font-medium text-brand-600 hover:text-brand-700">Back to sign in</Link>}
    >
      {loadError ? (
        <Notice kind="error">{loadError}</Notice>
      ) : !setup ? (
        <p className="flex items-center gap-2 text-sm text-ink-500"><Spinner className="size-4 text-brand-500" /> Preparing your QR code…</p>
      ) : (
        <form onSubmit={confirm} className="space-y-6">
          <ol className="space-y-5 text-sm text-ink-700">
            <li className="flex gap-3">
              <StepNumber n={1} />
              <span>
                Install an authenticator app if you don&apos;t have one:
                <span className="text-ink-500"> Google Authenticator, Microsoft Authenticator or 1Password.</span>
              </span>
            </li>
            <li className="flex gap-3">
              <StepNumber n={2} />
              <div className="flex-1">
                <p>Scan this QR code with the app.</p>
                <div className="mt-3 flex items-center gap-4 rounded-xl border border-ink-200 bg-white p-4 shadow-sm">
                  <div role="img" aria-label="QR code for your authenticator app" data-testid="totp-qr"
                    className="size-36 shrink-0 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: setup.qrSvg }} />
                  <div className="min-w-0 text-xs text-ink-500">
                    <p>Can&apos;t scan? Enter this key in the app instead:</p>
                    <p data-testid="totp-secret" className="mt-2 break-all font-mono text-[13px] font-medium tracking-wider text-ink-900">
                      {setup.secret.match(/.{1,4}/g)?.join(" ")}
                    </p>
                    <button type="button" onClick={copySecret}
                      className="mt-2 inline-flex items-center gap-1 font-medium text-brand-600 hover:text-brand-700">
                      {copied ? <><CheckIcon className="size-3.5" /> Copied</> : <><CopyIcon className="size-3.5" /> Copy key</>}
                    </button>
                  </div>
                </div>
                <p className="mt-2 text-xs text-ink-500">Account: {setup.email}</p>
              </div>
            </li>
            <li className="flex gap-3">
              <StepNumber n={3} />
              <div className="flex-1">
                <label htmlFor="code" className="block">Enter the 6-digit code the app shows.</label>
                {error && <Notice kind="error" className="mt-3">{error}</Notice>}
                <input id="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required
                  placeholder="000000" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  className={`mt-3 ${codeInputStyles}`} />
              </div>
            </li>
          </ol>
          <Button type="submit" size="lg" className="w-full" loading={busy} loadingText="Checking…">Confirm and continue</Button>
        </form>
      )}
    </AuthLayout>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700 ring-1 ring-brand-200">
      {n}
    </span>
  );
}
