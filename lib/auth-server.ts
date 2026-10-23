import { getSupabaseRouteClient } from "./supabase-route-client";
import { getSupabaseServerClient } from "./supabase-server";
import { ROLES, UserRole } from "./roles";

export interface AuthenticatedIdentity {
  userId: string;
  email: string | null;
  role: UserRole;
}

/**
 * Resolves the REAL, verified identity and role for the current request
 * from the httpOnly Supabase Auth session cookie -- never from a
 * client-supplied header. Returns null if nobody is signed in.
 *
 * A signed-in user with no row in `user_roles` yet (the migration in
 * supabase/migrations/0019_user_roles_and_rls.sql hasn't been run yet in
 * this environment, or an administrator hasn't assigned them a role) is
 * treated as the least-privileged role ("viewer") -- the same safe-default
 * rule lib/roles.ts's getRoleFromHeader has always followed. An account
 * existing is never, by itself, a reason to grant elevated access.
 *
 * Deliberately looks up the role with the service-role client
 * (lib/supabase-server.ts), not a client that depends on RLS being applied
 * correctly -- real authentication (this file) and RLS (Phase 1b's
 * migration) are independent layers. Auth must keep working even in a
 * project where the RLS migration hasn't been run yet.
 *
 * The whole session lookup is wrapped in its own try/catch, not just the
 * role lookup: `next/headers`' cookies() (inside
 * lib/supabase-route-client.ts) is only valid inside an actual Next.js
 * request context, and this function can legitimately be called somewhere
 * that isn't one (e.g. a test harness that invokes a route handler's
 * exported function directly, rather than through a real Next.js server).
 * Treating that as "no session" rather than letting it throw keeps
 * resolveRole()'s safe-default behavior (demo header or "viewer") working
 * in every environment, instead of turning an environment mismatch into an
 * unhandled rejection.
 */
export async function getAuthenticatedIdentity(): Promise<AuthenticatedIdentity | null> {
  let user: { id: string; email?: string | null } | null = null;
  try {
    const routeClient = getSupabaseRouteClient();
    const {
      data: { user: sessionUser },
    } = await routeClient.auth.getUser();
    user = sessionUser;
  } catch {
    return null;
  }

  if (!user) return null;

  let role: UserRole = "viewer";
  try {
    const serviceClient = getSupabaseServerClient();
    const { data, error } = await serviceClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!error && data && (ROLES as string[]).includes(data.role)) {
      role = data.role as UserRole;
    }
  } catch {
    // user_roles may not exist yet in this environment (migration not yet
    // applied) -- fail safe to "viewer" rather than throwing, so a signed-in
    // user still gets read-only access instead of a 500.
  }

  return { userId: user.id, email: user.email ?? null, role };
}
