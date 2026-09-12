import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
export const dynamic = "force-dynamic";

import { loadPersistedPlanView } from "@/lib/planning/weekly-plan-service";
import { DAYS_WITH_DATA, CURRENT_WEEK_START } from "@/lib/seed-data";

/**
 * The single endpoint behind the Weekly Planning page. Reads the
 * PERSISTED WeeklyPlan for the current week -- it no longer runs the
 * generation pipeline on every request. If no plan has been generated yet
 * for this week, `plan` comes back null and the page should show a
 * "Generate Draft" call to action rather than any computed content.
 */
export async function GET() {
  const supabase = getSupabaseServerClient();

  const view = await loadPersistedPlanView(supabase, CURRENT_WEEK_START, DAYS_WITH_DATA);
  if (!view) {
    return NextResponse.json({ plan: null, flights: [], roster: [], schedule: [], issues: [], planIssueCount: 0, configurationIssues: [] });
  }

  // `configurationIssues` is exposed here for a future Administration/
  // Configuration surface -- it is NOT read by the current Weekly
  // Planning UI (see PlanningSummaryBar), so an internal RAM-matrix gap
  // never inflates the operational Plan Warnings count.
  return NextResponse.json({
    plan: view.plan,
    flights: view.flights,
    roster: view.roster,
    schedule: view.schedule,
    issues: view.plan.issues,
    planIssueCount: view.plan.issues.length,
    configurationIssues: view.plan.configuration_issues,
  });
}
