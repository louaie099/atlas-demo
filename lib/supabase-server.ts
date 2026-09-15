import { createClient, SupabaseClient } from "@supabase/supabase-js";

let cachedClient: SupabaseClient | null = null;

/**
 * Server-only Supabase client using the service role key. Used exclusively
 * inside app/api/* route handlers, never imported into client components.
 */
export function getSupabaseServerClient(): SupabaseClient {
  if (cachedClient) return cachedClient;

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables. See .env.example."
    );
  }

  // FIX: PostgREST GET reads (plain .select() calls) were being served
  // stale by something caching the outbound GET between this server and
  // Supabase -- proven by the deployed dbConnection diagnostic, where a
  // .select() and an .rpc() (POST, never cached) against the identical
  // row in the same request returned different revisions. RPC calls are
  // POST and were never affected. This override adds explicit
  // no-cache/no-store directives to every request this client makes, so
  // no intermediary (CDN edge, proxy) has a cache-control reason to
  // reuse a prior GET response. No query/scheduling logic changed.
  cachedClient = createClient(url, serviceKey, {
    auth: { persistSession: false },
    global: {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Cache-Control", "no-cache, no-store, max-age=0, must-revalidate");
        headers.set("Pragma", "no-cache");
        return fetch(input, { ...init, headers, cache: "no-store" });
      },
    },
  });
  return cachedClient;
}
