import type { Metadata } from "next";
import { CONSOLE_THEME } from "../console/_components/theme";

export const metadata: Metadata = {
  title: "Eclypse QA console admin",
  robots: { index: false, follow: false },
};

/** /admin uses the console's dark theme. */
export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return (
    <div style={CONSOLE_THEME} className="flex flex-1 flex-col bg-ink-50 text-ink-900">
      {children}
    </div>
  );
}
