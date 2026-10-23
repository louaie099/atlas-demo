"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let cachedClient: SupabaseClient | null = null;

/**
 * Browser-side Supabase client, used only for Auth (sign-in/sign-up/sign-out,
 * reading the current session) -- never for data reads/writes. Every real
 * data read or write still goes through app/api/* route handlers, which use
 * either the service-role client (lib/supabase-server.ts) or, once Phase 1b
 * lands, a per-request user-scoped client. This client talks to Supabase
 * with the public anon key, which is safe to ship to the browser by design.
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to be
 * set -- see .env.example. Throws clearly rather than silently no-op'ing if
 * they're missing, so a misconfigured deployment fails loudly instead of
 * quietly leaving sign-in broken.
 */
export function getSupabaseBrowserClient(): SupabaseClient {
  if (cachedClient) return cachedClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. See .env.example."
    );
  }

  cachedClient = createBrowserClient(url, anonKey);
  return cachedClient;
}
