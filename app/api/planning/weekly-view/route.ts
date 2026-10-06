import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
export const dynamic = "force-dynamic";

import { loadPersistedPlanView, hashPlanInputs } from "@/lib/planning/weekly-plan-service";
import { resolveEffectiveConfig } from "@/lib/planning/rules-service";
import { DAYS_WITH_DATA, CURRENT_WEEK_START } from "@/lib/seed-data";
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
  if (flightsErr) return NextResponse.json({ error: flightsErr.message }, { status: 500, headers: { "Cache-Control": "no-store" } });

  // 2026-09-29 fix: loadPersistedPlanView throws a real Error on any
  // underlying Supabase error (a missing/misnamed table, a bad query --
  // see its own throws in weekly-plan-service.ts), and nothing here used
  // to catch that: it escaped this route as an uncaught exception, which
  // Next.js turns into its own generic, non-JSON 500 page. The client
  // couldn't parse that into a message, and (before app/planning/page.tsx's
  // own fix) it also left every piece of page state stuck on "loading"
  // forever. This still fails loudly on a genuine error -- it is turned
  // into a normal JSON error response, not swallowed.
  let view: Awaited<ReturnType<typeof loadPersistedPlanView>>;
  try {
    view = await loadPersistedPlanView(supabase, weekStart, DAYS_WITH_DATA);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
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
  // 2026-10-06 (Draft/Publish removal): no longer gated on
  // `view.plan.status === "draft"` -- there is no separate frozen
  // "published" state any more (Monthly Planning is always editable), so a
  // schedule/rule change must surface this banner for every plan, not just
  // one that still happens to carry the "draft" status value.
  let isStale = false;
  {
    const { data: allEmployees, error: empErr } = await supabase.from("employees").select("*");
    if (!empErr && allEmployees) {
      // Planning Rules milestone: the CURRENT resolved config (which
      // reflects any rule edit saved since this plan was generated), never
      // the plan's own frozen config_snapshot -- comparing against the
      // snapshot would trivially always match and could never detect a
      // rule change. This is what makes editing a rule surface the same
      // "schedule changed, click Make Planning" banner a flight-schedule
      // change already does, via the same existing mechanism.
      //
      // 2026-09-29 fix: resolveEffectiveConfig genuinely throws on a
      // Supabase error (eg. a missing planning_labor_rules/
      // planning_fatigue_config table when migration 0016 has not been
      // applied -- see rules-service.ts's own doc comment; that behavior
      // is correct and unchanged). Previously nothing here caught it, so
      // it propagated as an uncaught exception out of this whole route --
      // meaning a DRAFT week's normal view (not just the rules bar) failed
      // outright the moment that migration was missing. Staleness is a
      // secondary, best-effort signal (see the same pattern already used
      // two lines up for the employees query, `if (!empErr && ...)`): if
      // it can't be computed, this route still returns the real, already-
      // loaded plan/flights/roster/schedule -- it just skips the "schedule
      // changed" banner rather than failing the entire page for it.
      try {
        const currentConfig = await resolveEffectiveConfig(supabase);
        const currentHash = hashPlanInputs(weekFlights ?? [], allEmployees, currentConfig);
        isStale = currentHash !== view.plan.generated_from_hash;
      } catch (err) {
        // Logged, not hidden -- this is still a real problem (most likely
        // migration 0016 missing from this database), just not one that
        // should take down the whole Weekly Planning view for it. The
        // Planning Rules bar's own GET /api/planning/rules call surfaces
        // the same underlying error to the planner directly.
        console.error("weekly-view: could not resolve current config for staleness check:", err);
        isStale = false;
      }
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
