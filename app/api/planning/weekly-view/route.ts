import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
export const dynamic = "force-dynamic";

import { buildWeeklyPlanView } from "@/lib/planning/weekly-plan-view";
import { CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_LABEL } from "@/lib/seed-data";
import { Employee, Flight, StaffingRequirement, Assignment } from "@/lib/types";

/**
 * The single endpoint behind the Weekly Planning page. Fetches ONE
 * snapshot of flights/employees/assignments/requirements and runs
 * generateDraftWeeklyPlan() exactly once (via buildWeeklyPlanView) --
 * Flight Coverage (`roster`), Agent Schedule (`schedule`), and the
 * summary counts the page computes from `roster` all come from that one
 * computation. Replaces the page's previous two independent fetches to
 * /api/roster and /api/agent-schedule, which each read their own snapshot
 * and ran the full pipeline separately: same inputs give the same output
 * since the pipeline is pure, but two DB reads at two different moments
 * (e.g. while an assignment is being made) is a real race, and recomputing
 * the whole pipeline twice per page load was pure waste besides. Those two
 * routes are unchanged and still used elsewhere (the Dashboard reads
 * /api/roster), now backed by the same shared builder as this route so
 * there's no parallel view-construction logic either.
 */
export async function GET() {
  const supabase = getSupabaseServerClient();

  const [
    { data: flights, error: flightsErr },
    { data: employees, error: empErr },
    { data: assignments, error: assignErr },
    { data: requirements, error: reqErr },
  ] = await Promise.all([
    supabase.from("flights").select("*"),
    supabase.from("employees").select("*"),
    supabase.from("assignments").select("*"),
    supabase.from("staffing_requirements").select("*"),
  ]);

  if (flightsErr || empErr || assignErr || reqErr) {
    return NextResponse.json(
      { error: (flightsErr || empErr || assignErr || reqErr)?.message },
      { status: 500 }
    );
  }

  const { draftPlan, roster, schedule } = buildWeeklyPlanView(
    flights as Flight[],
    employees as Employee[],
    assignments as Assignment[],
    requirements as StaffingRequirement[],
    CONFIG,
    DAYS_WITH_DATA,
    CURRENT_WEEK_LABEL
  );

  return NextResponse.json({ roster, schedule, issues: draftPlan.issues, planIssueCount: draftPlan.issues.length });
}
