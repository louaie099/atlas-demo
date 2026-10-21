import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/nav-bar";
import { RoleProvider } from "@/components/role-context";

export const metadata: Metadata = {
  title: "Atlas — CMN Operations",
  description: "Airport Workforce Operations — Casablanca Mohammed V (CMN)",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen bg-surface font-sans antialiased text-ink">
        <RoleProvider>
          <div className="lg:flex min-h-screen">
            <Sidebar />
            <main className="flex-1 min-w-0 px-4 sm:px-8 lg:px-10 py-6 lg:py-9">
              <div className="max-w-[1180px] mx-auto">{children}</div>
            </main>
          </div>
        </RoleProvider>
      </body>
    </html>
  );
}
