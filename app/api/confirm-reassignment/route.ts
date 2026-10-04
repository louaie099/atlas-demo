import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { confirmReassignment } from "@/lib/live-ops-service";
import { ROLE_HEADER, getRoleFromHeader, canManageOperations } from "@/lib/roles";

export const dynamic = "force-dynamic";

/**
 * POST /api/confirm-reassignment — the write step of manual Live
 * Operations reassignment. Originally reachable only from the delay/
 * conflict-evaluation flow (components/edit-flight-drawer.tsx's
 * ConflictCard); as of 2026-10-04 this same endpoint is also called
 * directly from a plain "Change" action on any already-covered
 * requirement row (components/flight-ops-row.tsx), with no disruption
 * alert required first — confirmReassignment itself never depended on a
 * conflict existing, only on the (requirement, oldEmployeeId) pair
 * currently holding a real Assignment row, so no change was needed here
 * to support that. See lib/live-ops-service.ts's confirmReassignment for
 * the full write behavior — new Assignment row, `assignment_modifications`
 * row with action "replaced" (preserving the prior assignment in history),
 * and a human-readable `audit_log_entries` row.
 *
 * Request body:
 *   { staffingRequirementId: string, oldEmployeeId: string, newEmployeeId: string, reason: string }
 *
 * Response: `{ status: "confirmed", assignmentId: string }` on success,
 * or `{ error: string }` with a 4xx/5xx status.
 *
 * Role boundary (2026-10-04): only non-Viewer roles (Planner/
 * Administrator — see lib/roles.ts's canManageOperations doc comment)
 * may call this, checked server-side.
 */
export async function POST(req: Request) {
  const role = getRoleFromHeader(req.headers.get(ROLE_HEADER));
  if (!canManageOperations(role)) {
    return NextResponse.json({ error: "Viewers cannot make reassignments — Planner or Administrator role required." }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const { staffingRequirementId, oldEmployeeId, newEmployeeId, reason } = body;

  if (!staffingRequirementId || !oldEmployeeId || !newEmployeeId) {
    return NextResponse.json(
      { error: "staffingRequirementId, oldEmployeeId and newEmployeeId are required" },
      { status: 400 }
    );
  }

  const supabase = getSupabaseServerClient();
  const result = await confirmReassignment(supabase, {
    staffingRequirementId,
    oldEmployeeId,
    newEmployeeId,
    reason: reason ?? "",
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ status: "confirmed", assignmentId: result.assignmentId });
}
