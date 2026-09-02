import type { Metadata } from "next";
import "./globals.css";
import { NavBar } from "@/components/nav-bar";

export const metadata: Metadata = {
  title: "Atlas — CMN Operations",
  description: "Airport Workforce Operations demo — Casablanca Mohammed V (CMN)",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-surface font-sans antialiased">
        <NavBar />
        <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-10">{children}</main>
      </body>
    </html>
  );
}
