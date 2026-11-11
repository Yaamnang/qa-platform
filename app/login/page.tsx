"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Field, Notice } from "@/components/ui";
import { postJson } from "@/lib/client/api";
import { errorMessage } from "../console/_components/api";
import { AuthCard } from "../console/_components/AuthCard";
import { SecretField } from "../console/_components/SecretField";

/** Console sign-in, step 1: email and password. The API says whether a code or authenticator setup comes next. */
export default function ConsoleLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { next } = await postJson<{ next: "verify" | "setup" }>("/api/console/auth/login", { email, password });
      setPassword("");
      router.push(next === "setup" ? "/console/setup" : "/console/verify");
    } catch (err) {
      setError(errorMessage(err, "Could not reach the console. Try again."));
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Sign in">
      <form onSubmit={submit} className="space-y-5">
        <Field id="email" label="Work email" type="email" autoComplete="username" required autoFocus
          placeholder="you@eclypse-ai.com" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="login-email" />
        <SecretField id="password" label="Password" autoComplete="current-password" required testId="login-password"
          placeholder="Enter your password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <Notice kind="error" testId="login-error">{error}</Notice>}
        <Button type="submit" size="lg" className="w-full" loading={busy} loadingText="Checking…" data-testid="login-submit">
          Continue
        </Button>
      </form>
    </AuthCard>
  );
}
