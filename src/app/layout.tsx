import type { Metadata } from "next";
import "./globals.css";

// Type comes from Normal's font stacks in globals.css (system fonts until PP Neue Montreal is
// licensed), so there are no web fonts to load.
export const metadata: Metadata = {
  title: "Module One · Normal",
  description: "Weekly 360 check-in and team-health heat-map.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
