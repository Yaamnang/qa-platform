import type { Metadata } from "next";
import SignInLayout from "../console/(auth)/layout";
import { CONSOLE_THEME } from "../console/_components/theme";

export const metadata: Metadata = {
  title: "Eclypse QA console",
  description: "Internal tool for running QA against Eclypse deployments.",
};

/**
 * The main sign-in, for the QA console. It lives at /login rather than under
 * /console, so it sets the console's dark theme and sign-in layout itself.
 * The stand-in's own sign-in is at /fake/login.
 */
export default function LoginLayout({ children }: LayoutProps<"/login">) {
  return (
    <div style={CONSOLE_THEME} className="flex flex-1 flex-col bg-ink-50 text-ink-900">
      <SignInLayout>{children}</SignInLayout>
    </div>
  );
}
