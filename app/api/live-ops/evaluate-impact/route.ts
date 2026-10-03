import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { evaluateFlightDelayImpact } from "@/lib/live-ops-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/live-ops/evaluate-impact — body `{ flightId: string }`.
 * READ-ONLY conflict detection + replacement recommendation for a flight
 * whose timing has (or may have) changed operationally. Call this after
 * PATCH /api/flights/[id]/operational to see what, if anything, that
 * change broke. Never writes to the database — the actual reassignment
 * only happens via POST /api/confirm-reassignment, after a human
 * confirms.
 *
 * Response shape (see lib/live-ops-service.ts's LiveOpsImpact for the
 * authoritative type):
 *
 *   {
 *     flight: Flight,
 *     conflicts: [
 *       {
 *         requirement: StaffingRequirement,
 *         oldWindow: { start, end },
 *         newWindow: { start, end },
 *         employee: Employee,                    // the now-conflicted employee
 *         collidesWith: {                         // their other commitment that now collides
 *           requirement: StaffingRequirement,
 *           flight: Flight,
 *           window: { start, end },
 *         },
 *         replacementCandidates: CandidateResult[], // ranked, excludes the conflicted employee; empty = no eligible replacement, a real gap
 *         exclusionSummary?: { reason: string, count: number }[],
 *       }
 *     ]
 *   }
 *
 * `conflicts: []` means the current (possibly updated) departure creates
 * no real scheduling collision for anyone currently assigned.
 */
export async function POST(req: Request) {
  const { flightId } = await req.json().catch(() => ({}));
  if (!flightId) {
    return NextResponse.json({ error: "flightId is required" }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();
  const result = await evaluateFlightDelayImpact(supabase, flightId);

  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
