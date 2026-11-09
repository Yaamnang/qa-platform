import type { Metadata } from "next";
import { CONSOLE_THEME } from "./_components/theme";

export const metadata: Metadata = {
  title: "Eclypse QA console",
  description: "Internal tool for running QA against Eclypse deployments.",
};

/** Everything under /console: dark theme, separate from the stand-in platform. */
export default function ConsoleLayout({ children }: LayoutProps<"/console">) {
  return (
    <div style={CONSOLE_THEME} className="flex flex-1 flex-col bg-ink-50 text-ink-900">
      {children}
    </div>
  );
}
