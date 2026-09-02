/**
 * This is a demo-grade role model, NOT a real authentication/session
 * system — there is no login, no user accounts, no verified identity.
 * It exists specifically to make the permission BOUNDARY real and
 * demonstrable: the current role is sent as a header on every mutating
 * request, and the API routes actually check it (see
 * app/api/employees/route.ts and app/api/employees/[id]/route.ts) — this
 * is not enforced only by hiding a button in the UI. When real
 * authentication exists, this header should be replaced by a verified
 * session/JWT claim; the enforcement shape (check role before mutating,
 * reject otherwise) stays the same.
 */
export type UserRole = "viewer" | "planner" | "administrator";

export const ROLES: UserRole[] = ["viewer", "planner", "administrator"];

export const ROLE_LABELS: Record<UserRole, string> = {
  viewer: "Viewer",
  planner: "Planner",
  administrator: "Administrator",
};

/**
 * Only Administrators may create, edit, or deactivate employee workforce
 * profiles (name, assignment, qualifications, authorizations, active
 * status). Viewers and Planners can see all of this — they just can't
 * change it. Daily shifts/weekly hours are never editable here at all,
 * for anyone — that's Weekly Planning's job, not this form's.
 */
export function canManageEmployees(role: UserRole): boolean {
  return role === "administrator";
}

export const ROLE_HEADER = "x-atlas-role";

/**
 * Reads the demo role from a request header, defaulting to the LEAST
 * privileged role ("viewer") if missing or invalid — the safe default
 * even in a demo, since "no role asserted" should never imply elevated
 * permission.
 */
export function getRoleFromHeader(headerValue: string | null): UserRole {
  if (headerValue === "planner" || headerValue === "administrator") return headerValue;
  return "viewer";
}
