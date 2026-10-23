import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Reachable without a session: the sign-in page itself, the magic-link
// landing route that completes sign-in, and /api/me (whose entire job is
// to truthfully answer "are you signed in?" -- gating it would make it
// lie by omission to a signed-out visitor instead of saying so).
const PUBLIC_PATHS = ["/login", "/auth/callback", "/api/me"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Keeps the Supabase Auth session cookie fresh on every request -- the
 * standard Supabase SSR pattern for Next.js App Router -- AND is the one
 * place that enforces "you must be signed in (or this deployment has
 * explicitly opted in to demo mode) to reach Atlas at all". Before this,
 * a signed-out visitor wasn't turned away anywhere: pages silently
 * rendered for them and data routes like GET /api/employees had no
 * resolveRole() call at all, so the real gate was "do you have the
 * link", not "do you have an account" -- exactly backwards for a
 * platform with real logins and real workforce data.
 *
 * This still isn't where ROLE (Viewer vs Planner vs Administrator) is
 * decided -- that stays in lib/resolve-role.ts and lib/roles.ts's
 * canManage*() functions, applied per-route. This is strictly "signed in
 * or not", checked once, centrally, instead of scattered across ~30
 * route handlers (most of which, like GET /api/employees, never had
 * their own check to begin with).
 *
 * A page request with no session redirects to /login (carrying `next`
 * so sign-in can return the person to where they were headed); an API
 * request with no session gets a 401 JSON body instead, since a fetch()
 * call can't follow a redirect into an HTML page usefully.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // If Supabase Auth isn't configured in this environment yet, don't block
  // every request on it -- just pass through unchanged. (Real data routes
  // still fail closed on their own if required env vars are missing; this
  // middleware is purely a session-refresh convenience in that case.)
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

  // getUser() both triggers the refresh-if-needed behavior and tells us
  // whether anyone is actually signed in.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const demoModeOn = process.env.ATLAS_ALLOW_DEMO_ROLE_HEADER === "true";

  if (!user && !demoModeOn && !isPublicPath(pathname)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Sign in to use Atlas." }, { status: 401 });
    }

    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

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
