import type { ReactNode } from "react";

/**
 * One of the console's sign-in steps: heading, form, optional footer link.
 * The panel around it, with the logo and the local-demo notice, is
 * app/console/(auth)/layout.tsx.
 */
export function AuthCard({ title, children, footer, wide = false }: { title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return (
    <div className={`w-full animate-pop-in ${wide ? "max-w-[480px]" : "max-w-[400px]"}`}>
      <h1 className="text-2xl font-semibold tracking-tight text-ink-900">{title}</h1>
      <div className="mt-8">{children}</div>
      {footer && <div className="mt-8 text-sm text-ink-500">{footer}</div>}
    </div>
  );
}
