import type { ReactNode } from "react";
import { EclypseBackdrop } from "@/components/eclype/EclypseBackdrop";
import { Wordmark } from "@/components/ui";
import { LocalNotice } from "../_components/LocalMode";
import { SIGN_IN_THEME } from "../_components/theme";

/**
 * The sign-in steps (sign in, authenticator setup, code). A full-height white
 * panel on the left holds the logo, the step's form and the local-demo notice.
 * It sets SIGN_IN_THEME, the light colours, since it sits inside the dark
 * console. From 1024px the Eclype scene fills the rest of the window on the
 * right: a still poster at once, the live scene faded in over it once the page
 * is idle (see components/eclype). Below that the form panel takes the whole width.
 *
 * Also used by app/login/layout.tsx, which is the same sign-in at /login.
 */
export default function SignInLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-1">
      <section style={SIGN_IN_THEME} className="flex w-full flex-col bg-white px-8 py-10 text-ink-900 sm:px-14 lg:w-[min(600px,46vw)] lg:shrink-0 lg:border-r lg:border-ink-200">
        <div className="flex items-center gap-3">
          <Wordmark tone="dark" className="-ml-3 h-8" />
          <span aria-hidden="true" className="h-5 w-px bg-ink-200" />
          <span className="text-sm font-medium text-brand-600">QA console</span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center py-12">{children}</div>
        <div className="flex justify-center">
          <LocalNotice />
        </div>
      </section>
      <EclypseBackdrop className="relative flex-1" />
    </main>
  );
}
