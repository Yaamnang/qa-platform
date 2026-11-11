"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { codeInputStyles } from "@/components/AuthLayout";
import { CheckIcon, CopyIcon } from "@/components/icons";
import { Button, Notice } from "@/components/ui";
import { api, postJson } from "@/lib/client/api";
import { consolePath, errorMessage } from "../../_components/api";
import { AuthCard } from "../../_components/AuthCard";
import { InlineLoading } from "../../_components/states";

type Setup = { email: string; secret: string; otpauthUri: string; qrSvg: string };

/**
 * First sign-in: connect an authenticator app. Same steps as the platform's
 * own setup page: scan the QR code (or type the key), then enter the first code.
 */
export default function ConsoleSetupPage() {
  const router = useRouter();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api<Setup>("/api/console/auth/setup")
      .then(setSetup)
      .catch((err) => setLoadError(errorMessage(err, "Could not start authenticator setup.")));
  }, []);

  async function confirm(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { next } = await postJson<{ next: string }>("/api/console/auth/setup", { code });
      setSetup(null);
      router.replace(consolePath(next));
    } catch (err) {
      setError(errorMessage(err, "Could not reach the console. Try again."));
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
    <AuthCard title="Set up your authenticator" wide
      footer={<Link href="/login" data-testid="setup-back" className="font-medium text-brand-600 hover:text-brand-700">Back to sign in</Link>}>
      {loadError ? (
        <Notice kind="error" testId="setup-load-error">{loadError}</Notice>
      ) : !setup ? (
        <InlineLoading label="Preparing your QR code…" />
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
              <div className="min-w-0 flex-1">
                <p>Scan this QR code with the app.</p>
                <div className="mt-3 flex items-center gap-4 rounded-xl border border-ink-200 bg-ink-50 p-4">
                  {/* Literal white behind the code: scanners need dark modules on a light quiet zone. */}
                  <div role="img" aria-label="QR code for your authenticator app" data-testid="totp-qr"
                    className="size-32 shrink-0 rounded-lg bg-[#fff] p-2 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: setup.qrSvg }} />
                  <div className="min-w-0 text-xs text-ink-500">
                    <p>Can&apos;t scan? Enter this key instead:</p>
                    <p data-testid="totp-secret" className="mt-2 break-words font-mono text-[13px] font-medium tracking-wider text-ink-900">
                      {setup.secret.match(/.{1,4}/g)?.join(" ")}
                    </p>
                    <button type="button" onClick={copySecret} data-testid="totp-copy"
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
              <div className="min-w-0 flex-1">
                <label htmlFor="code" className="block">Enter the six-digit code the app shows.</label>
                <input id="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required
                  placeholder="000000" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  className={`mt-3 ${codeInputStyles}`} data-testid="totp-code" />
                {error && <Notice kind="error" className="mt-3" testId="totp-error">{error}</Notice>}
              </div>
            </li>
          </ol>
          <Button type="submit" size="lg" className="w-full" loading={busy} loadingText="Checking…" data-testid="totp-submit">
            Confirm and continue
          </Button>
        </form>
      )}
    </AuthCard>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700 ring-1 ring-brand-200">
      {n}
    </span>
  );
}
