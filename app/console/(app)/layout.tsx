import type { ReactNode } from "react";
import { ConsoleShell } from "../_components/ConsoleShell";
import { LocalMarker } from "../_components/LocalMode";

/** Signed-in console pages. The sign-in steps live in (auth) and have no top bar. */
export default function SignedInLayout({ children }: { children: ReactNode }) {
  // The marker is a server component, so it is made here and handed to the client-side shell.
  return <ConsoleShell marker={<LocalMarker />}>{children}</ConsoleShell>;
}
