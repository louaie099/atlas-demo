import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Keeps the Supabase Auth session cookie fresh on every request -- the
 * standard Supabase SSR pattern for Next.js App Router. Without this,
 * server-side `supabase.auth.getUser()` calls (lib/auth-server.ts) can see
 * a stale/expired session on long-lived pages, because Route Handlers and
 * Server Components can read cookies but can't always durably persist a
 * refreshed token themselves.
 *
 * This middleware does not enforce any permission -- it only refreshes the
 * cookie. Every real permission check still happens where it always has:
 * server-side, in the route handler, via lib/resolve-role.ts and
 * lib/roles.ts's canManage*() functions.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // If Supabase Auth isn't configured in this environment yet, don't block
  // every request on it -- just pass through unchanged. (Real data routes
  // still fail closed on their own if required env vars are missing; this
  // middleware is purely a session-refresh convenience.)
  if (!url || !anonKey) {
    return response;
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      get(name: string) {
        return request.cookies.get(name)?.value;
      },
      set(name: string, value: string, options: Record<string, unknown>) {
        request.cookies.set({ name, value });
        response = NextResponse.next({ request });
        response.cookies.set({ name, value, ...options });
      },
      remove(name: string, options: Record<string, unknown>) {
        request.cookies.set({ name, value: "" });
        response = NextResponse.next({ request });
        response.cookies.set({ name, value: "", ...options });
      },
    },
  });

  // Touching getUser() is what actually triggers the refresh-if-needed
  // behavior; the result itself isn't used here.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    /*
     * Run on everything except static assets and Next's own internals --
     * no point refreshing a session cookie for a font or a favicon.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
