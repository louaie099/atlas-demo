import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { computeBoardingRequirement, computeCheckinRequirement } from "@/lib/demand-forecast";
import { CONFIG } from "@/lib/seed-data";
import { Flight } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase.from("flights").select("*").order("scheduled_departure");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ flights: data });
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Creates a flight and its staffing requirement in one call. The requirement
 * is always computed by the same Planning Engine logic used at seed time —
 * never hand-entered — so a flight added from the UI follows the same rule
 * as one added at seed: Boarding is a fixed rule, Check-in/ACE is the only
 * role that responds to booking pressure. This keeps the "not a generic
 * overbooking multiplier" architectural constraint intact even for
 * interface-created data, not just the seeded scenario.
 */
export async function POST(req: Request) {
  const supabase = getSupabaseServerClient();
  const body = await req.json();

  const {
    flight_number,
    airline,
    route,
    aircraft,
    scheduled_departure,
    gate = null,
    boarding_window_start = null,
    boarding_window_end = null,
    booking_pressure = "normal",
    role, // "Boarding" | "Check-in/ACE" — which requirement to generate
    boarding_baseline, // only used when role === "Boarding"
  } = body;

  if (!flight_number || !airline || !route || !aircraft || !scheduled_departure || !role) {
    return NextResponse.json(
      { error: "flight_number, airline, route, aircraft, scheduled_departure, and role are required" },
      { status: 400 }
    );
  }

  if (role !== "Boarding" && role !== "Check-in/ACE") {
    return NextResponse.json(
      { error: 'role must be "Boarding" or "Check-in/ACE" — no other roles have Planning Engine logic defined yet' },
      { status: 400 }
    );
  }

  const flightId = slugify(flight_number);
  const { data: existing } = await supabase.from("flights").select("id").eq("id", flightId).maybeSingle();
  if (existing) {
    return NextResponse.json({ error: `A flight with id "${flightId}" already exists` }, { status: 409 });
  }

  const flight: Flight = {
    id: flightId,
    flight_number,
    airline,
    route,
    aircraft,
    scheduled_departure,
    gate,
    boarding_window_start,
    boarding_window_end,
    status: "scheduled",
    booking_pressure,
  };

  const { error: flightErr } = await supabase.from("flights").insert(flight);
  if (flightErr) return NextResponse.json({ error: flightErr.message }, { status: 500 });

  const requirement =
    role === "Boarding"
      ? {
          role: "Boarding",
          baseline_requirement: Number(boarding_baseline) || 3,
          additional_requirement: 0,
          total_requirement: Number(boarding_baseline) || 3,
          source: "fixed_rule" as const,
          reasoning: `${Number(boarding_baseline) || 3} Boarding agents required per ${aircraft} configuration.`,
        }
      : computeCheckinRequirement(flight, CONFIG);

  const requirementId = `req-${flightId}-${slugify(requirement.role)}`;
  const { data: reqData, error: reqErr } = await supabase
    .from("staffing_requirements")
    .insert({ id: requirementId, flight_id: flightId, ...requirement })
    .select()
    .single();

  if (reqErr) return NextResponse.json({ error: reqErr.message }, { status: 500 });

  const { data: lastStep } = await supabase
    .from("audit_log_entries")
    .select("step_number")
    .order("step_number", { ascending: false })
    .limit(1)
    .single();
  const nextStep = (lastStep?.step_number ?? 0) + 1;

  await supabase.from("audit_log_entries").insert({
    id: `audit-${nextStep}`,
    step_number: nextStep,
    description: `New flight added to weekly plan: ${flight_number} (${route}). ${requirement.reasoning}`,
  });

  return NextResponse.json({ flight, requirement: reqData });
}
