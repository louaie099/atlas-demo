import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
export const dynamic = "force-dynamic";

import { makePlanning } from "@/lib/planning/weekly-plan-service";
import { CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_LABEL, CURRENT_WEEK_START } from "@/lib/seed-data";

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
 * and refuses to show success until they match -- see that component's
 * doc comment for why a bare "the refetch resolved" was never a strong
 * enough guarantee (an intermediate cache or a lagging read replica can
 * return a resolved-but-stale response).
 *
 * `Cache-Control: no-store` is set explicitly on the response, not left
 * to `export const dynamic = "force-dynamic"` alone -- that flag governs
 * Next's OWN server-side data/route cache, but says nothing about an
 * intermediate HTTP cache (a CDN edge, a corporate proxy) sitting between
 * the browser and this function; only a real Cache-Control header on the
 * wire can tell those layers not to reuse this response.
 */
export async function POST() {
  const supabase = getSupabaseServerClient();

  const result = await makePlanning(supabase, CURRENT_WEEK_START, CURRENT_WEEK_LABEL, DAYS_WITH_DATA, CONFIG);
  if ("blocked" in result) {
    return NextResponse.json({ error: result.reason }, { status: 409, headers: { "Cache-Control": "no-store" } });
  }

  return NextResponse.json(
    { plan: result.plan, revision: result.plan.revision, summary: result.summary },
    { headers: { "Cache-Control": "no-store" } }
  );
}
