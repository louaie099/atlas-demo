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
 * endpoint because the Dashboard (app/page.tsx) reads only the roster
 * view and doesn't need Agent Schedule alongside it.
 */
export async function GET() {
  const supabase = getSupabaseServerClient();

  const [{ data: flights, error: flightsErr }, { data: requirements, error: reqErr }, { data: assignments, error: assignErr }, { data: employees, error: empErr }] =
    await Promise.all([
      supabase.from("flights").select("*"),
      supabase.from("staffing_requirements").select("*"),
      supabase.from("assignments").select("*"),
      supabase.from("employees").select("*"),
    ]);

  if (flightsErr || reqErr || assignErr || empErr) {
    return NextResponse.json(
      { error: (flightsErr || reqErr || assignErr || empErr)?.message },
      { status: 500 }
    );
  }

  const { draftPlan, roster } = buildWeeklyPlanView(
    flights as Flight[],
    employees as Employee[],
    assignments as Assignment[],
    requirements as StaffingRequirement[],
    CONFIG,
    DAYS_WITH_DATA,
    CURRENT_WEEK_LABEL
  );

  return NextResponse.json({ roster, planIssueCount: draftPlan.issues.length });
}
