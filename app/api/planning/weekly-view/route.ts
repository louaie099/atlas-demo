import { NextResponse } from "next/server";

import { getSupabaseServerClient, getSupabaseProjectRefForDiagnostics } from "@/lib/supabase-server";
export const dynamic = "force-dynamic";

import { loadPersistedPlanView, planIdForWeek, fetchAllRosterEntriesForPlan, fetchAllAssignmentsForPlan } from "@/lib/planning/weekly-plan-service";
import { DAYS_WITH_DATA, CURRENT_WEEK_START } from "@/lib/seed-data";

/**
 * The single endpoint behind the Weekly Planning page. Reads the
 * PERSISTED WeeklyPlan for the current week -- it no longer runs the
 * generation pipeline on every request. If no plan has been generated yet
 * for this week, `plan` comes back null and the page should show a
 * "Generate Draft" call to action rather than any computed content.
 *
 * `Cache-Control: no-store` is set explicitly, on every branch, for the
 * same reason as the make-planning route: this is read immediately after
 * Make Planning persists a new revision (see MakePlanningButton's
 * consistency check), and a cached response here -- from a CDN edge, a
 * corporate proxy, or the browser's own HTTP cache -- would silently hand
 * back the plan as it looked BEFORE that write, no matter how correctly
 * the write itself succeeded. The client's own `fetch(..., { cache:
 * "no-store" })` call is a second, independent line of defense for the
 * same failure mode -- neither one alone is guaranteed to be honored by
 * every intermediary, so both are set.
 *
 * The `diagnostics` block is TEMPORARY, part of the deployed read-after-
 * write investigation: `supabaseProjectRef` is the same non-secret
 * identifier POST /api/planning/make-planning now reports (see
 * getSupabaseProjectRefForDiagnostics's doc comment) -- if the two ever
 * disagree on a real deployed request, the write and this read are
 * proven to be talking to two different Supabase projects/credentials,
 * which is the single most important fact this investigation needs.
 * `rosterCount`/`assignmentCount` are fresh, independent reads of the raw
 * tables (not derived from the transformed `roster`/`schedule` views
 * below), for a direct, apples-to-apples comparison against the same
 * counts regenerateDraftPlan's own diagnostics reported a moment earlier.
 */
export async function GET() {
  const supabase = getSupabaseServerClient();
  const noStore = { headers: { "Cache-Control": "no-store" } };
  const supabaseProjectRef = getSupabaseProjectRefForDiagnostics();
  const planId = planIdForWeek(CURRENT_WEEK_START);

  const view = await loadPersistedPlanView(supabase, CURRENT_WEEK_START, DAYS_WITH_DATA);
  if (!view) {
    return NextResponse.json(
      {
        plan: null,
        flights: [],
        roster: [],
        schedule: [],
        issues: [],
        planIssueCount: 0,
        configurationIssues: [],
        diagnostics: { supabaseProjectRef, planId, revision: null, rosterCount: 0, assignmentCount: 0 },
      },
      noStore
    );
  }

  const [rawRosterEntries, rawAssignments] = await Promise.all([
    fetchAllRosterEntriesForPlan(supabase, planId),
    fetchAllAssignmentsForPlan(supabase, planId),
  ]);

  // `configurationIssues` is exposed here for a future Administration/
  // Configuration surface -- it is NOT read by the current Weekly
  // Planning UI (see PlanningSummaryBar), so an internal RAM-matrix gap
  // never inflates the operational Plan Warnings count.
  return NextResponse.json(
    {
      plan: view.plan,
      flights: view.flights,
      roster: view.roster,
      schedule: view.schedule,
      issues: view.plan.issues,
      planIssueCount: view.plan.issues.length,
      configurationIssues: view.plan.configuration_issues,
      diagnostics: {
        supabaseProjectRef,
        planId,
        revision: view.plan.revision,
        rosterCount: rawRosterEntries.length,
        assignmentCount: rawAssignments.length,
      },
    },
    noStore
  );
}
