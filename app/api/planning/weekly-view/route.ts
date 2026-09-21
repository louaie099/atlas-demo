import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
export const dynamic = "force-dynamic";

import { loadPersistedPlanView, hashPlanInputs } from "@/lib/planning/weekly-plan-service";
import { CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_START } from "@/lib/seed-data";
import { weekLabelFor } from "@/lib/flight-date";

/**
 * The single endpoint behind the Weekly Planning page. Reads the
 * PERSISTED WeeklyPlan for the given week (?week_start=YYYY-MM-DD;
 * defaults to the original demo week so existing callers keep working)
 * -- it no longer runs the generation pipeline on every request. If no
 * plan has been generated yet for this week, `plan` comes back null and
 * the page should show a "Generate Draft"/"Make Planning" call to
 * action rather than any computed content -- but `flights` is still
 * populated (fetched independently of plan existence, scoped to this
 * week) so Flight Schedule and Add/Edit/Remove/Import Flights all work
 * BEFORE a plan has ever been generated for a new week, not only after.
 *
 * `weekStart`/`weekLabel` are always echoed back in the response so the
 * client can bootstrap its own week-selection state from whatever this
 * route actually resolved (its own query param, or the default) without
 * needing to hardcode or duplicate that default itself.
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
 * every intermediary, so both are set. The actual fix for this route
 * consistently returning a stale revision lives in getSupabaseServerClient
 * (lib/supabase-server.ts): its fetch override disables intermediary
 * caching of every GET this server client makes to Supabase.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const weekStart = searchParams.get("week_start") ?? CURRENT_WEEK_START;
  const weekLabel = weekLabelFor(weekStart);
  const supabase = getSupabaseServerClient();
  const noStore = { headers: { "Cache-Control": "no-store" } };

  const { data: weekFlights, error: flightsErr } = await supabase
    .from("flights")
    .select("*")
    .eq("week_start", weekStart)
    .order("flight_date")
    .order("scheduled_departure");
  if (flightsErr) return NextResponse.json({ error: flightsErr.message }, { status: 500 });

  const view = await loadPersistedPlanView(supabase, weekStart, DAYS_WITH_DATA);
  if (!view) {
    return NextResponse.json(
      {
        weekStart,
        weekLabel,
        plan: null,
        flights: weekFlights ?? [],
        roster: [],
        schedule: [],
        zoneCoverage: [],
        issues: [],
        planIssueCount: 0,
        configurationIssues: [],
      },
      noStore
    );
  }

  // `isStale`: true when the flight schedule (or workforce/config, though
  // those rarely change week to week) has changed since THIS plan was
  // generated -- reuses generated_from_hash, already computed and
  // persisted on every plan (see hashPlanInputs' own doc comment) but
  // never compared against anything until now. Never auto-regenerates:
  // this only tells the UI to show a "schedule changed, click Make
  // Planning" banner -- changing the flight schedule must never silently
  // regenerate the plan on its own.
  let isStale = false;
  if (view.plan.status === "draft") {
    const { data: allEmployees, error: empErr } = await supabase.from("employees").select("*");
    if (!empErr && allEmployees) {
      const currentHash = hashPlanInputs(weekFlights ?? [], allEmployees, CONFIG);
      isStale = currentHash !== view.plan.generated_from_hash;
    }
  }

  // `configurationIssues` is exposed here for a future Administration/
  // Configuration surface -- it is NOT read by the current Weekly
  // Planning UI (see PlanningSummaryBar), so an internal RAM-matrix gap
  // never inflates the operational Plan Warnings count.
  return NextResponse.json(
    {
      weekStart,
      weekLabel,
      plan: view.plan,
      isStale,
      flights: weekFlights ?? [],
      roster: view.roster,
      schedule: view.schedule,
      zoneCoverage: view.zoneCoverage,
      issues: view.plan.issues,
      planIssueCount: view.plan.issues.length,
      configurationIssues: view.plan.configuration_issues,
    },
    noStore
  );
}
