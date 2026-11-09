import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Eclypse Platform (stand-in)",
  description: "Stand-in AI platform used to demonstrate automated frontend QA.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
