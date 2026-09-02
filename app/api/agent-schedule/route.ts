import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
export const dynamic = "force-dynamic";

import { buildWeeklyPlanView } from "@/lib/planning/weekly-plan-view";
import { CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_LABEL } from "@/lib/seed-data";
import { Employee, Flight, StaffingRequirement, Assignment } from "@/lib/types";

/**
 * Thin wrapper over the shared buildWeeklyPlanView() — same builder
 * /api/planning/weekly-view uses — so this route's view-construction
 * logic can't drift from the Weekly Planning page's. Kept as its own
 * endpoint for any standalone consumer of just the Agent Schedule view.
 */
export async function GET() {
  const supabase = getSupabaseServerClient();

  const [{ data: employees, error: empErr }, { data: assignments, error: assignErr }, { data: requirements, error: reqErr }, { data: flights, error: flightErr }] =
    await Promise.all([
      supabase.from("employees").select("*"),
      supabase.from("assignments").select("*"),
      supabase.from("staffing_requirements").select("*"),
      supabase.from("flights").select("*"),
    ]);

  if (empErr || assignErr || reqErr || flightErr) {
    return NextResponse.json(
      { error: (empErr || assignErr || reqErr || flightErr)?.message },
      { status: 500 }
    );
  }

  const { schedule } = buildWeeklyPlanView(
    flights as Flight[],
    employees as Employee[],
    assignments as Assignment[],
    requirements as StaffingRequirement[],
    CONFIG,
    DAYS_WITH_DATA,
    CURRENT_WEEK_LABEL
  );

  return NextResponse.json({ schedule });
}
