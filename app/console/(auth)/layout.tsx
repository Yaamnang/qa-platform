import type { ReactNode } from "react";
import { EclypseBackdrop } from "@/components/eclype/EclypseBackdrop";
import { LocalNotice } from "../_components/LocalMode";

/**
 * The sign-in steps (sign in, authenticator setup, code): the step's card with
 * the local-demo notice under it. Centred on small screens; from 1024px it sits
 * on the left so the Eclype scene, which fills the window behind it with the
 * moon on the right, stays in view. A soft shade on the left keeps the text
 * around the card readable.
 */
export default function SignInLayout({ children }: { children: ReactNode }) {
  return (
    <main className="relative isolate flex flex-1 flex-col items-center justify-center px-6 py-12 lg:items-start lg:pl-[8vw]">
      <EclypseBackdrop className="fixed inset-0 -z-10" />
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 hidden lg:block"
        style={{ background: "radial-gradient(ellipse 45% 70% at 22% 50%, rgb(5 4 15 / 0.75), transparent)" }} />
      {children}
      <LocalNotice />
    </main>
  );
}
