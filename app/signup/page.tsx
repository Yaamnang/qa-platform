"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { AuthLayout } from "@/components/AuthLayout";
import { SparkleIcon } from "@/components/icons";
import { PasswordField } from "@/components/PasswordField";
import { Button, Field, Notice } from "@/components/ui";
import { ApiError, postJson } from "@/lib/client/api";

type Values = { displayName: string; email: string; password: string; confirmPassword: string };

/** Rough strength: 0-4. Only a hint for the user; the server enforces the real rule (12+ chars). */
function passwordStrength(p: string): { score: number; label: string } {
  if (!p) return { score: 0, label: "" };
  let score = p.length >= 12 ? 1 : 0;
  if (p.length >= 16) score++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) score++;
  if (/\d/.test(p) && /[^A-Za-z0-9]/.test(p)) score++;
  if (p.length < 12) return { score: Math.min(score, 1), label: `${12 - p.length} more characters needed` };
  return { score, label: ["Too short", "Okay", "Good", "Strong", "Very strong"][score] };
}

const METER = ["bg-red-400", "bg-amber-400", "bg-lime-500", "bg-emerald-500"];

/**
 * A random 20-character password, made in the browser with the crypto API
 * (never sent anywhere until the user submits the form). It always has a
 * lowercase letter, an uppercase letter, a digit and a symbol. Look-alike
 * characters (l, I, O, 0, 1) are left out so it is easy to copy by hand.
 */
function generatePassword(length = 20): string {
  const sets = ["abcdefghijkmnpqrstuvwxyz", "ABCDEFGHJKLMNPQRSTUVWXYZ", "23456789", "!@#$%^&*-_=+?"];
  const random = (max: number) => crypto.getRandomValues(new Uint32Array(1))[0] % max;
  const pick = (chars: string) => chars[random(chars.length)];
  const all = sets.join("");
  const chars = [...sets.map(pick), ...Array.from({ length: length - sets.length }, () => pick(all))];
  // Shuffle (Fisher-Yates) so the guaranteed characters are not always first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/** Sign-up: account details. Next comes the authenticator, then the organization. */
export default function SignupPage() {
  const router = useRouter();
  const [values, setValues] = useState<Values>({ displayName: "", email: "", password: "", confirmPassword: "" });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof Values, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  /** The last generated password, so the "save it" note goes away if the user types their own. */
  const [generated, setGenerated] = useState("");
  const strength = passwordStrength(values.password);

  function fillGeneratedPassword() {
    const password = generatePassword();
    setValues({ ...values, password, confirmPassword: password });
    setFieldErrors({ ...fieldErrors, password: undefined, confirmPassword: undefined });
    setGenerated(password);
    // Show it, so the user can see it and save it.
    setShowPassword(true);
    setShowConfirm(true);
  }

  const bind = (key: keyof Values) => ({
    value: values[key],
    error: fieldErrors[key],
    onChange: (e: { target: { value: string } }) => setValues({ ...values, [key]: e.target.value }),
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await postJson("/api/auth/signup", values);
      router.push("/signup/authenticator");
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        setError(err.message);
      } else {
        setError("Something went wrong.");
      }
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Create your staff account"
      subtitle="For Eclypse employees. It takes about a minute, and you will need an authenticator app on your phone."
      footer={<>Already have an account? <Link href="/login" className="font-medium text-brand-600 hover:text-brand-700">Sign in</Link></>}
    >
      {error && <Notice kind="error" className="mb-5">{error}</Notice>}
      <form onSubmit={submit} noValidate className="space-y-5">
        <Field id="displayName" label="Full name" autoComplete="name" autoFocus placeholder="Jane Doe" {...bind("displayName")} />
        <Field id="email" label="Work email" type="email" autoComplete="email" placeholder="you@eclypse-ai.com" {...bind("email")} />
        <div>
          <PasswordField id="password" label="Password" autoComplete="new-password" placeholder="Create a password"
            revealed={showPassword} onRevealedChange={setShowPassword}
            aside={
              <button type="button" onClick={fillGeneratedPassword}
                className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700">
                <SparkleIcon className="size-3.5" /> Generate strong password
              </button>
            }
            hint={!fieldErrors.password && !values.password ? "At least 12 characters. A short sentence works well." : undefined}
            {...bind("password")} />
          {values.password && !fieldErrors.password && (
            <div className="mt-2" aria-live="polite">
              <div aria-hidden="true" className="flex gap-1">
                {METER.map((color, i) => (
                  <span key={color} className={`h-1 flex-1 rounded-full transition-colors ${i < strength.score ? METER[strength.score - 1] : "bg-ink-200"}`} />
                ))}
              </div>
              <p className="mt-1 text-xs text-ink-500">{strength.label}</p>
              {generated && values.password === generated && (
                <p className="mt-1 text-xs text-ink-700">Save this password in your password manager before you continue.</p>
              )}
            </div>
          )}
        </div>
        <PasswordField id="confirmPassword" label="Confirm password" autoComplete="new-password" placeholder="Type the password again"
          revealed={showConfirm} onRevealedChange={setShowConfirm} {...bind("confirmPassword")} />
        <Button type="submit" size="lg" className="w-full" loading={busy} loadingText="Creating account…">Create account</Button>
      </form>
    </AuthLayout>
  );
}
