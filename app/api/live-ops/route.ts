import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { loadLiveOpsView } from "@/lib/live-ops-service";
import { todayISO } from "@/lib/flight-date";

export const dynamic = "force-dynamic";

/**
 * GET /api/live-ops?date=YYYY-MM-DD — Live Operations' real-data read
 * route. Replaces the old hardcoded "at201" demo logic: every flight
 * shown here is a real flight for the given date, read from the exact
 * same persisted plan Monthly Planning uses (loadPersistedPlanView), not
 * a separate planned_duties toy system.
 *
 * `date` defaults to today (server-local calendar date — see
 * lib/flight-date.ts's todayISO). The response shape (see
 * lib/live-ops-service.ts's LiveOpsView for the authoritative type):
 *
 *   {
 *     date: "YYYY-MM-DD",
 *     weekStart: "YYYY-MM-DD",
 *     plan: { id, status, revision } | null, // status kept for backward compatibility, never gates anything here
 *     flights: [
 *       {
 *         flight: Flight,                 // includes actual_departure if set
 *         effectiveDeparture: "HH:mm",    // actual_departure ?? scheduled_departure
 *         requirements: [
 *           {
 *             requirement: StaffingRequirement,
 *             coverageLabel: string,
 *             coverageStatus: "assigned" | "gap",
 *             gap: number,
 *             assignedEmployees: Employee[],  // a human-made (Assignment.source "human_modified") pick
 *             proposedEmployees: Employee[], // ATLAS's own (Assignment.source "atlas_generated") pick -- already a real row, just styled distinctly
 *           }
 *         ]
 *       }
 *     ]
 *   }
 *
 * `plan: null` means no plan exists yet for this date's week at all — show
 * "no plan for this date". 2026-10-06 (Draft/Publish removal): this route
 * always resolves whatever is CURRENTLY persisted for the date's week,
 * regardless of `plan.status` — there is no separate "published" milestone
 * in the product any more (see live-ops-service.ts's own doc comment).
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date") ?? todayISO();

  const supabase = getSupabaseServerClient();
  const view = await loadLiveOpsView(supabase, date);

  return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
}
