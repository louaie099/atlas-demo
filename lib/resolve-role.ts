import { UserRole, getRoleFromHeader, ROLE_HEADER } from "./roles";
import { getAuthenticatedIdentity } from "./auth-server";

/**
 * The one place every route handler should get "what role is this request
 * acting as" from -- replaces the five separate
 * `getRoleFromHeader(req.headers.get(ROLE_HEADER))` call sites that used to
 * trust a client-supplied header unconditionally. Precedence, strict and in
 * this order:
 *
 *   1. A real, verified Supabase Auth session (lib/auth-server.ts) -- if one
 *      exists, ITS role wins, full stop. A request header can never
 *      override or downgrade a real session's role, and can't forge a
 *      higher one either: it's simply never consulted once a session
 *      exists.
 *   2. Only if there is NO real session, AND this deployment has explicitly
 *      opted in to demo mode (ATLAS_ALLOW_DEMO_ROLE_HEADER=true) -- the
 *      original x-atlas-role header, read exactly as before. This keeps the
 *      quick role-switcher demo working wherever it's deliberately turned
 *      on, without it being reachable in a real deployment by default.
 *   3. Otherwise: "viewer", the safe default -- a signed-out visitor to a
 *      deployment with demo mode off gets read-only access, never silently
 *      elevated.
 *
 * ATLAS_ALLOW_DEMO_ROLE_HEADER is read directly from process.env (never
 * cached at module load) so a production deployment that simply never sets
 * it is safe by construction -- there is no way to reach the header
 * fallback except by explicitly opting in.
 */
export async function resolveRole(req: Request): Promise<UserRole> {
  const identity = await getAuthenticatedIdentity();
  if (identity) return identity.role;

  if (process.env.ATLAS_ALLOW_DEMO_ROLE_HEADER === "true") {
    return getRoleFromHeader(req.headers.get(ROLE_HEADER));
  }

  return "viewer";
}
