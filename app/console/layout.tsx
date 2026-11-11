import type { Metadata } from "next";
import { SIGN_IN_THEME } from "./_components/theme";

export const metadata: Metadata = {
  title: "Eclypse QA console",
  description: "Internal tool for running QA against Eclypse deployments.",
};

/**
 * Everything under /console: white, with the sky-blue accent that tells it apart
 * from the stand-in platform. SIGN_IN_THEME is the light set of colours in
 * theme.ts, the same one the sign-in panel uses.
 */
export default function ConsoleLayout({ children }: LayoutProps<"/console">) {
  return (
    <div style={SIGN_IN_THEME} className="flex flex-1 flex-col bg-ink-50 text-ink-900">
      {children}
    </div>
  );
}
