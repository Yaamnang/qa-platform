import Image from "next/image";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { AlertIcon, CheckCircleIcon, InfoIcon, Spinner } from "./icons";

/**
 * Shared building blocks so every page looks the same.
 * Accessibility is part of the design: labels are real <label>s, messages use
 * role="alert"/"status", and the QA robot finds things the same way a screen
 * reader user would.
 */

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 " +
  "disabled:cursor-not-allowed disabled:opacity-60";

const BUTTON_VARIANTS = {
  primary: "bg-brand-600 text-white shadow-sm hover:bg-brand-700 active:bg-brand-800",
  secondary: "border border-ink-200 bg-white text-ink-800 shadow-sm hover:bg-ink-50 active:bg-ink-100",
  danger: "bg-red-600 text-white shadow-sm hover:bg-red-700",
  ghost: "text-ink-600 hover:bg-ink-100 hover:text-ink-900",
} as const;

const BUTTON_SIZES = { sm: "h-8 px-3 text-sm", md: "h-10 px-4 text-sm", lg: "h-11 px-5 text-[15px]" } as const;

export type ButtonVariant = keyof typeof BUTTON_VARIANTS;

/** Class string for things that look like buttons but are links (<a>, <Link>). */
export function buttonStyles(variant: ButtonVariant = "primary", size: keyof typeof BUTTON_SIZES = "md", extra = "") {
  return `${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} ${extra}`;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: keyof typeof BUTTON_SIZES;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  /** Text shown while loading (default: children). */
  loadingText?: string;
  icon?: ReactNode;
};

export function Button({ variant = "primary", size = "md", loading, loadingText, icon, className = "", children, disabled, ...rest }: ButtonProps) {
  return (
    <button {...rest} disabled={disabled || loading} className={buttonStyles(variant, size, className)}>
      {loading ? <Spinner /> : icon}
      {loading && loadingText ? loadingText : children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

export const inputStyles =
  "block w-full rounded-lg border border-ink-200 bg-white px-3 py-2.5 text-sm text-ink-900 shadow-sm " +
  "placeholder:text-ink-400 transition-colors " +
  "focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-100 " +
  "aria-[invalid=true]:border-red-400 aria-[invalid=true]:focus:ring-red-100";

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string;
  /** Extra content on the right of the label row (e.g. "Forgot password?"). */
  aside?: ReactNode;
  /** A small button inside the right edge of the input (e.g. show/hide password). */
  addon?: ReactNode;
};

/** Label + input + hint/error, wired together for screen readers. */
export function Field({ id, label, hint, error, aside, addon, className = "", ...input }: FieldProps) {
  const describedBy = [error && `${id}-error`, hint && `${id}-hint`].filter(Boolean).join(" ") || undefined;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <label htmlFor={id} className="text-sm font-medium text-ink-800">{label}</label>
        {aside}
      </div>
      <div className="relative">
        <input id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy}
          className={`${inputStyles} ${addon ? "pr-11" : ""} ${className}`} {...input} />
        {addon}
      </div>
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 flex items-center gap-1 text-xs font-medium text-red-600">
          <AlertIcon className="size-3.5 shrink-0" />{error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-ink-500">{hint}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const NOTICE = {
  error: { role: "alert", box: "border-red-200 bg-red-50 text-red-800", icon: <AlertIcon className="mt-0.5 size-4 shrink-0 text-red-500" /> },
  success: { role: "status", box: "border-emerald-200 bg-emerald-50 text-emerald-800", icon: <CheckCircleIcon className="mt-0.5 size-4 shrink-0 text-emerald-600" /> },
  info: { role: "note", box: "border-brand-200 bg-brand-50 text-brand-900", icon: <InfoIcon className="mt-0.5 size-4 shrink-0 text-brand-500" /> },
  warning: { role: "note", box: "border-amber-200 bg-amber-50 text-amber-900", icon: <AlertIcon className="mt-0.5 size-4 shrink-0 text-amber-500" /> },
} as const;

/**
 * A message box. Errors are announced as alerts, successes as status.
 * The box contains only the message text, so the text a user (or test)
 * reads is exactly the message.
 */
export function Notice({ kind, children, className = "", testId }: { kind: keyof typeof NOTICE; children: ReactNode; className?: string; testId?: string }) {
  const n = NOTICE[kind];
  return (
    <div className={`flex animate-fade-in gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${n.box} ${className}`}>
      {n.icon}
      <p role={n.role} data-testid={testId} className="leading-5">{children}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout pieces
// ---------------------------------------------------------------------------

/** A titled panel. The title also names the region for screen readers (and tests). */
export function Card({ title, description, action, children, className = "", bodyClassName = "p-5" }: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section aria-label={title} className={`mb-6 overflow-hidden rounded-xl border border-ink-200 bg-white shadow-card ${className}`}>
      <div className="flex items-start justify-between gap-4 border-b border-ink-100 px-5 py-4">
        <div>
          <h2 className="text-[15px] font-semibold text-ink-900">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-ink-500">{description}</p>}
        </div>
        {action}
      </div>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, eyebrow, actions }: { title: string; description?: ReactNode; eyebrow?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow && <div className="mb-2 text-sm text-ink-500">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-ink-500">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

const BADGE_TONES = {
  neutral: "bg-ink-100 text-ink-700 ring-ink-200",
  brand: "bg-brand-50 text-brand-700 ring-brand-200",
  success: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  warning: "bg-amber-50 text-amber-800 ring-amber-200",
  danger: "bg-red-50 text-red-700 ring-red-200",
} as const;

export function Badge({ tone = "neutral", children, className = "" }: { tone?: keyof typeof BADGE_TONES; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${BADGE_TONES[tone]} ${className}`}>
      {children}
    </span>
  );
}

/** Initials in a coloured square: used for organizations and people. */
export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
  const palette = ["bg-brand-100 text-brand-700", "bg-sky-100 text-sky-700", "bg-emerald-100 text-emerald-700", "bg-amber-100 text-amber-800", "bg-rose-100 text-rose-700"];
  const tone = palette[[...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % palette.length];
  const dims = { sm: "size-7 text-[11px] rounded-md", md: "size-9 text-xs rounded-lg", lg: "size-11 text-sm rounded-xl" }[size];
  return <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center font-semibold ${dims} ${tone}`}>{initials}</span>;
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-ink-100 text-ink-500">{icon}</div>
      <p className="text-sm font-medium text-ink-800">{title}</p>
      {children && <div className="mt-1 max-w-sm text-sm text-ink-500">{children}</div>}
    </div>
  );
}

export function LoadingScreen({ label = "Loading…" }: { label?: string }) {
  return (
    <main className="flex flex-1 items-center justify-center gap-2 text-sm text-ink-500">
      <Spinner className="size-4 text-brand-500" /> {label}
    </main>
  );
}

/**
 * Eclypse AI logo, from eclypse-ai.com.
 * tone="dark": dark letters, for white backgrounds (default).
 * tone="light": white letters, for dark backgrounds.
 */
export function Wordmark({ className = "", tone = "dark" }: { className?: string; tone?: "dark" | "light" }) {
  return (
    <Image
      src={tone === "light" ? "/brand/eclypse-wordmark-white.svg" : "/brand/eclypse-wordmark-dark.svg"}
      alt="Eclypse AI"
      width={381}
      height={127}
      loading="eager"
      className={`block h-12 w-auto ${className}`}
    />
  );
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC",
});
/** Same output on every machine: fixed locale and time zone. */
export const formatDate = (ms: number) => `${DATE.format(ms)} UTC`;
