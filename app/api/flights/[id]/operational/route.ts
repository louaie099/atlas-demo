import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { Flight, FlightStatus } from "@/lib/types";
import { FlightPhase, FLIGHT_PHASE_LABEL } from "@/lib/flight-phase";

export const dynamic = "force-dynamic";

const TIME_RE = /^\d{2}:\d{2}$/;
const VALID_STATUSES: FlightStatus[] = ["scheduled", "delayed"];
const VALID_PHASES = Object.keys(FLIGHT_PHASE_LABEL) as FlightPhase[];

/**
 * PATCH /api/flights/[id]/operational — Live Operations' Edit Flight
 * route. Separate from the full-rewrite PUT at app/api/flights/[id]/route.ts
 * (untouched, still owns Flight Schedule's planning-time edit), and
 * intentionally narrow: writes ONLY the operational fields below, never
 * `scheduled_departure`, `flight_number`, `day_of_week`, or any other
 * planning-time field.
 *
 * Request body (all optional — send only what's changing):
 *   {
 *     actual_departure?: string | null,  // "HH:mm", or null to clear back to scheduled
 *     status?: "scheduled" | "delayed",
 *     gate?: string | null,              // reuses the existing `gate` column — never read by generation
 *     operational_phase_override?: FlightPhase | null, // null = follow the clock (lib/flight-phase.ts)
 *   }
 *
 * Response: `{ flight: Flight }` — the updated row.
 *
 * This route does NOT itself run conflict detection — call POST
 * /api/live-ops/evaluate-impact with the same flightId afterward to see
 * the impact of the change.
 */
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => ({}));
  const { actual_departure, status, gate, operational_phase_override } = body as {
    actual_departure?: string | null;
    status?: string;
    gate?: string | null;
    operational_phase_override?: string | null;
  };

  const patch: Partial<Flight> = {};

  if ("actual_departure" in body) {
    if (actual_departure !== null && !TIME_RE.test(actual_departure ?? "")) {
      return NextResponse.json({ error: "actual_departure must be in HH:mm format, or null" }, { status: 400 });
    }
    patch.actual_departure = actual_departure;
  }

  if ("status" in body) {
    if (!VALID_STATUSES.includes(status as FlightStatus)) {
      return NextResponse.json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` }, { status: 400 });
    }
    patch.status = status as FlightStatus;
  }

  if ("gate" in body) {
    patch.gate = gate;
  }

  if ("operational_phase_override" in body) {
    if (operational_phase_override !== null && !VALID_PHASES.includes(operational_phase_override as FlightPhase)) {
      return NextResponse.json(
        { error: `operational_phase_override must be null or one of: ${VALID_PHASES.join(", ")}` },
        { status: 400 }
      );
    }
    patch.operational_phase_override = operational_phase_override as FlightPhase | null;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { error: "No recognized fields in request body (actual_departure, status, gate, operational_phase_override)." },
      { status: 400 }
    );
  }

  const supabase = getSupabaseServerClient();
  const { data: existing, error: fetchErr } = await supabase.from("flights").select("*").eq("id", params.id).single();
  if (fetchErr || !existing) return NextResponse.json({ error: "Flight not found" }, { status: 404 });

  const { error: updateErr } = await supabase.from("flights").update(patch).eq("id", params.id);
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  return NextResponse.json({ flight: { ...existing, ...patch } });
}
