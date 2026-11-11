"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { codeInputStyles } from "@/components/AuthLayout";
import { Button, Notice } from "@/components/ui";
import { postJson } from "@/lib/client/api";
import { consolePath, errorMessage } from "../../_components/api";
import { AuthCard } from "../../_components/AuthCard";

/** Console sign-in, step 2: the six-digit code from the employee's authenticator app. */
export default function ConsoleVerifyPage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { next } = await postJson<{ next: string }>("/api/console/auth/verify", { code });
      router.replace(consolePath(next));
    } catch (err) {
      setError(errorMessage(err, "Could not reach the console. Try again."));
      setCode("");
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Enter your code"
      footer={<Link href="/login" data-testid="verify-back" className="font-medium text-brand-600 hover:text-brand-700">Use a different account</Link>}>
      <form onSubmit={submit} className="space-y-5">
        <div>
          <label htmlFor="code" className="mb-1.5 block text-sm font-medium text-ink-800">Six-digit code from your authenticator app</label>
          <input id="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus
            placeholder="000000" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            className={codeInputStyles} data-testid="totp-code" />
        </div>
        {error && <Notice kind="error" testId="totp-error">{error}</Notice>}
        <Button type="submit" size="lg" className="w-full" loading={busy} loadingText="Verifying…" data-testid="totp-submit">
          Verify
        </Button>
      </form>
    </AuthCard>
  );
}
