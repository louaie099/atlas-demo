import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
export const dynamic = "force-dynamic";

import { Flight } from "@/lib/types";
import { classifyDestinationOperationally } from "@/lib/destination-classification";
import { dayOfWeekFor, weekStartFor } from "@/lib/flight-date";

/**
 * GET /api/flights?week_start=YYYY-MM-DD — every flight for the given
 * display week. week_start is REQUIRED: there is no longer an implicit
 * "the current week" (see docs and CURRENT_WEEK_START's own doc comment
 * in seed-data.ts) — every caller must say which week it wants.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const weekStart = searchParams.get("week_start");
  if (!weekStart) {
    return NextResponse.json({ error: "week_start query parameter is required, e.g. ?week_start=2026-09-01" }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase.from("flights").select("*").eq("week_start", weekStart).order("flight_date").order("scheduled_departure");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ flights: data ?? [] });
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * POST /api/flights — Add Flight. Collects only the fields the planning
 * engine actually needs (flight identity, route, timing, aircraft) —
 * never a hand-entered staffing number. destination_category and
 * operator_type are ALWAYS derived here, the same way every other
 * flight in the system gets them (classifyDestinationOperationally,
 * lib/destination-classification.ts) — an unrecognized destination
 * produces destination_category: null (surfaced downstream as
 * needs_configuration by the requirements layer, exactly like a seeded
 * flight with the same gap), never a guessed category. Staffing
 * requirements are never computed or stored here: they fall out of the
 * normal Make Planning pipeline (lib/planning/weekly-requirements.ts),
 * computed fresh from this flight every time, exactly like every other
 * flight — this route's only job is inserting into `flights`.
 */
export async function POST(req: Request) {
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
  if (!/^\d{2}:\d{2}$/.test(scheduled_departure)) {
    return NextResponse.json({ error: "scheduled_departure must be in HH:mm format" }, { status: 400 });
  }

  const dayOfWeek = dayOfWeekFor(flight_date);
  const weekStart = weekStartFor(flight_date);
  const id = `${slugify(flight_number)}-${flight_date}`;

  const { data: existing } = await supabase
    .from("flights")
    .select("id")
    .eq("flight_date", flight_date)
    .eq("flight_number", flight_number)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ error: `${flight_number} on ${flight_date} already exists.` }, { status: 409 });
  }

  const destinationCategory = classifyDestinationOperationally(destination);
  const operatorType = airline === "Royal Air Maroc" ? "atlas_managed" : "self_managed";

  const flight: Flight = {
    id,
    flight_number,
    airline,
    route: `${origin} → ${destination}`,
    origin,
    destination,
    aircraft,
    equipment_code: null,
    registration: null,
    callsign: null,
    terminal,
    scheduled_departure,
    scheduled_arrival: null,
    gate: null,
    boarding_window_start: null,
    boarding_window_end: null,
    status: "scheduled",
    booking_pressure,
    day_of_week: dayOfWeek,
    flight_date,
    week_start: weekStart,
    operator_type: operatorType,
    destination_category: destinationCategory,
    booked_passengers: null,
    seat_capacity: null,
  };

  const { error } = await supabase.from("flights").insert(flight);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ flight });
}
