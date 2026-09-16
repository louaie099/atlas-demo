import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
export const dynamic = "force-dynamic";

import { makePlanning } from "@/lib/planning/weekly-plan-service";
import { CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_START } from "@/lib/seed-data";
import { weekLabelFor } from "@/lib/flight-date";

/**
 * Make Planning -- the single endpoint behind the Weekly Planning page's
 * "Make Planning" button (see makePlanning's own doc comment in
 * weekly-plan-service.ts for the full state-machine it runs). This is the
 * ONLY route that creates or changes a plan in response to a normal
 * planner action: a plain GET/page-load never reaches here (see
 * /api/planning/weekly-view, which only reads whatever was last
 * persisted) -- a plan only ever changes because someone explicitly
 * clicked Make Planning.
 *
 * The response carries `revision` (mirroring `plan.revision`, pulled out
 * to the top level so the client never has to reach into `plan` just to
 * do the read-after-write consistency check below) -- this is the exact
 * revision number the transaction above just committed. The client
 * (components/make-planning-button.tsx) compares THIS number against
 * whatever revision the follow-up GET /api/planning/weekly-view reports,
 * and refuses to show success until they match.
 *
 * `Cache-Control: no-store` is set explicitly on the response, not left
 * to `export const dynamic = "force-dynamic"` alone -- that flag governs
 * Next's OWN server-side data/route cache, but says nothing about an
 * intermediate HTTP cache (a CDN edge, a corporate proxy) sitting between
 * the browser and this function; only a real Cache-Control header on the
 * wire can tell those layers not to reuse this response.
 */
export async function POST(req: Request) {
  const supabase = getSupabaseServerClient();
  // week_start selects WHICH week's flight schedule Make Planning reads
  // from and which week's WeeklyPlan it writes to -- defaults to the
  // original demo week so a caller that predates week selection (or the
  // "Reset Demo" flow) keeps working unchanged. weekLabelFor computes the
  // display label from the date itself, rather than requiring a second,
  // independently-maintained label per week.
  let weekStart = CURRENT_WEEK_START;
  try {
    const body = await req.json();
    if (body?.week_start) weekStart = body.week_start;
  } catch {
    // No JSON body sent (e.g. a bare POST with no body) -- fall back to the default week, not an error.
  }
  const weekLabel = weekLabelFor(weekStart);

  try {
    const result = await makePlanning(supabase, weekStart, weekLabel, DAYS_WITH_DATA, CONFIG);
    if ("blocked" in result) {
      return NextResponse.json({ error: result.reason }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }

    return NextResponse.json(
      {
        plan: result.plan,
        revision: result.plan.revision,
        summary: result.summary,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    // A thrown error here (most likely verifyPlanPersisted's own
    // diagnostic message -- see weekly-plan-service.ts) means the write
    // did NOT verifiably land; surface the exact message instead of a
    // generic 500 with no detail, so a real failure is immediately
    // actionable from the response body alone.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
