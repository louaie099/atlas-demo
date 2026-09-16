import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
export const dynamic = "force-dynamic";

import { classifyDestinationOperationally } from "@/lib/destination-classification";
import { dayOfWeekFor, weekStartFor } from "@/lib/flight-date";

/**
 * PUT /api/flights/[id] — Edit Flight. Same field set as Add Flight, same
 * derivation rules (destination_category/operator_type/day_of_week/
 * week_start are always recomputed from what's submitted, never taken
 * as given) — editing a flight is never a way to hand-set a staffing
 * number or a classification that wasn't independently derivable.
 * Re-deriving the id would break every persisted staffing_requirement/
 * assignment/duty that references the OLD flight_id, so the id is
 * intentionally immutable here even if flight_number or flight_date
 * change — this updates the existing row in place.
 */
export async function PUT(req: Request, { params }: { params: { id: string } }) {
  const supabase = getSupabaseServerClient();
  const body = await req.json();
  const { flight_number, airline, flight_date, scheduled_departure, destination, origin = "CMN", aircraft, terminal = "T1", booking_pressure = "normal" } = body;

  const missing = ["flight_number", "airline", "flight_date", "scheduled_departure", "destination", "aircraft"].filter((k) => !body[k]);
  if (missing.length > 0) {
    return NextResponse.json({ error: `Missing required field(s): ${missing.join(", ")}` }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(flight_date)) {
    return NextResponse.json({ error: "flight_date must be a real calendar date in YYYY-MM-DD format" }, { status: 400 });
  }

  const dayOfWeek = dayOfWeekFor(flight_date);
  const weekStart = weekStartFor(flight_date);
  const destinationCategory = classifyDestinationOperationally(destination);
  const operatorType = airline === "Royal Air Maroc" ? "atlas_managed" : "self_managed";

  const { data, error } = await supabase
    .from("flights")
    .update({
      flight_number,
      airline,
      route: `${origin} → ${destination}`,
      origin,
      destination,
      aircraft,
      terminal,
      scheduled_departure,
      booking_pressure,
      day_of_week: dayOfWeek,
      flight_date,
      week_start: weekStart,
      operator_type: operatorType,
      destination_category: destinationCategory,
    })
    .eq("id", params.id)
    .select()
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: `No flight with id "${params.id}"` }, { status: 404 });
  return NextResponse.json({ flight: data });
}

/**
 * DELETE /api/flights/[id] — Remove Flight. Deletes the flight row only.
 * Its staffing_requirements were always computed fresh at Make Planning
 * time (never stored independently of the flight), so removing the
 * flight already means it will never be requested again on the next
 * generation — nothing else needs cleanup here. Does NOT touch any
 * already-persisted WeeklyPlan/roster/duties for a week that was already
 * generated or published; those stay exactly as they are until the next
 * Make Planning click regenerates from the updated schedule (see the
 * Draft-staleness banner).
 */
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const supabase = getSupabaseServerClient();
  const { error } = await supabase.from("flights").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
