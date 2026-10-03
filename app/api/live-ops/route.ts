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
 *     plan: { id, status: "draft" | "published", revision } | null,
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
 *             assignedEmployees: Employee[],  // real, confirmed assignments table rows
 *             proposedEmployees: Employee[], // the draft-plan engine's own picks, not yet real rows
 *           }
 *         ]
 *       }
 *     ]
 *   }
 *
 * `plan: null` means no plan (draft or published) exists yet for this
 * date's week at all — show "no plan for this date", distinct from a
 * draft plan existing but nothing published (`plan.status === "draft"`,
 * `flights` still populated). This route does NOT hard-gate on
 * `status === "published"` — see live-ops-service.ts's own doc comment.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date") ?? todayISO();

  const supabase = getSupabaseServerClient();
  const view = await loadLiveOpsView(supabase, date);

  return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
}
