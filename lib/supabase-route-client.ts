import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Per-request, cookie-aware Supabase client for use INSIDE app/api/* route
 * handlers (and server components) -- never module-level cached, because it
 * carries one specific request's session cookies. This is the only
 * trustworthy way to find out "who is actually signed in" on the server: it
 * reads the httpOnly session cookie Supabase Auth set, not anything the
 * client can forge in a header.
 *
 * Uses the PUBLIC anon key, not the service-role key -- this client is
 * subject to RLS (once Phase 1b's policies are applied) and can only do
 * what the signed-in user themselves is allowed to do. lib/supabase-server.ts's
 * service-role client remains a separate, more powerful client reserved for
 * genuinely admin-only / cross-user operations (reset, reseed), still gated
 * by lib/admin-guard.ts.
 */
export function getSupabaseRouteClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) or NEXT_PUBLIC_SUPABASE_ANON_KEY. See .env.example."
    );
  }

  const cookieStore = cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options: Record<string, unknown>) {
        try {
          cookieStore.set({ name, value, ...options });
        } catch {
          // Route Handlers running in some contexts (e.g. during static
          // rendering) can't set cookies; middleware.ts is what actually
          // keeps the session cookie refreshed in those cases.
        }
      },
      remove(name: string, options: Record<string, unknown>) {
        try {
          cookieStore.set({ name, value: "", ...options });
        } catch {
          // See note above.
        }
      },
    },
  });
}
