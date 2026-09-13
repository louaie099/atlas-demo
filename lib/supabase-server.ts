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

  cachedClient = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });
  return cachedClient;
}

/**
 * TEMPORARY DIAGNOSTIC HELPER -- part of the deployed read-after-write
 * investigation (see the diagnostics blocks returned by
 * /api/planning/make-planning and /api/planning/weekly-view). Extracts
 * only the Supabase PROJECT REF -- the subdomain of SUPABASE_URL, e.g.
 * "abcdefghijklmnop" out of "https://abcdefghijklmnop.supabase.co" -- and
 * nothing else. This is not a secret: it's the same identifier that
 * appears in the plaintext hostname of every REST/realtime request the
 * browser or server ever makes to Supabase, visible to anyone who opens
 * devtools on the deployed app. Returning it lets us prove or disprove
 * "are the write request and the read request actually talking to the
 * same Supabase project" without ever touching SUPABASE_SERVICE_ROLE_KEY
 * or the full URL. Returns "unknown" rather than throwing if SUPABASE_URL
 * is missing or unparseable, since this must never be the reason a real
 * request fails.
 */
export function getSupabaseProjectRefForDiagnostics(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) return "unknown (SUPABASE_URL not set)";
  try {
    const host = new URL(url).hostname; // e.g. "abcdefghijklmnop.supabase.co"
    return host.split(".")[0] || host;
  } catch {
    return "unknown (SUPABASE_URL unparseable)";
  }
}
