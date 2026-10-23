import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase-route-client";

/**
 * Magic-link landing route: Supabase redirects here with a `code` query
 * param after the person clicks the email link from app/login/page.tsx's
 * signInWithOtp() call. Exchanging it for a session here (server-side, via
 * the cookie-aware route client) is what actually sets the session cookie
 * that lib/auth-server.ts later reads -- the browser client alone can't
 * complete this exchange for an email-link flow.
 */
export async function GET(req: Request) {
  const { searchParams, origin } = new URL(req.url);
  const code = searchParams.get("code");

  if (code) {
    const supabase = getSupabaseRouteClient();
    await supabase.auth.exchangeCodeForSession(code);
  }

  return NextResponse.redirect(`${origin}/`);
}
