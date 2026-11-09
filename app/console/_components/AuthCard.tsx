import type { ReactNode } from "react";
import { ConsoleName } from "./ConsoleName";

/**
 * The panel for one of the console's sign-in steps, no artwork. The page
 * around it, which centres it and adds the local-demo notice, is
 * app/console/(auth)/layout.tsx.
 */
export function AuthCard({ title, children, footer, wide = false }: { title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return (
    <div className={`w-full animate-pop-in ${wide ? "max-w-[500px]" : "max-w-[420px]"}`}>
      <ConsoleName className="mb-6 block" />
      <div className="rounded-2xl border border-ink-200 bg-white p-8">
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">{title}</h1>
        <div className="mt-6">{children}</div>
      </div>
      {footer && <div className="mt-6 text-center text-sm text-ink-500">{footer}</div>}
    </div>
  );
}
