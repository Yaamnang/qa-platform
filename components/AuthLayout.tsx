import type { ReactNode } from "react";
import { Wordmark } from "./ui";

/** Layout for sign-in, sign-up and authenticator setup: the logo, then the card, centred. */
export function AuthLayout({ title, subtitle, children, footer }: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center bg-ink-50 px-6 py-12">
      <div className="w-full max-w-[440px] animate-pop-in">
        <Wordmark className="mx-auto mb-8 h-9!" />
        <div className="rounded-2xl border border-ink-200 bg-white p-8 shadow-card">
          <h1 className="text-2xl font-semibold tracking-tight text-ink-900">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-ink-500">{subtitle}</p>}
          <div className="mt-8">{children}</div>
        </div>
        {footer && <div className="mt-6 text-center text-sm text-ink-500">{footer}</div>}
      </div>
    </main>
  );
}

/** Big, spaced-out single input for 6-digit codes. One field, so paste and autofill just work. */
export const codeInputStyles =
  "block w-full rounded-xl border border-ink-200 bg-white py-3.5 text-center indent-[0.5em] font-mono text-2xl tracking-[0.5em] " +
  "text-ink-900 shadow-sm placeholder:text-ink-300 focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-100";
