import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { confirmReassignment } from "@/lib/live-ops-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/confirm-reassignment — the write step of the Live Operations
 * reassignment flow, called only after a human confirms one of
 * evaluate-impact's recommended replacement candidates (or picks another
 * eligible employee). Repurposed from the old hardcoded
 * plannedDuty/"at201" version: body and persistence are both new (see
 * lib/live-ops-service.ts's confirmReassignment for the full write
 * behavior — new Assignment row, `assignment_modifications` row with
 * action "replaced", and a human-readable `audit_log_entries` row).
 *
 * Request body:
 *   { staffingRequirementId: string, oldEmployeeId: string, newEmployeeId: string, reason: string }
 *
 * Response: `{ status: "confirmed", assignmentId: string }` on success,
 * or `{ error: string }` with a 4xx/5xx status.
 */
export async function POST(req: Request) {
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
