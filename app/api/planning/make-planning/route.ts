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
 */
export async function POST() {
  const supabase = getSupabaseServerClient();

  const result = await makePlanning(supabase, CURRENT_WEEK_START, CURRENT_WEEK_LABEL, DAYS_WITH_DATA, CONFIG);
  if ("blocked" in result) {
    return NextResponse.json({ error: result.reason }, { status: 409 });
  }

  return NextResponse.json({ plan: result.plan, summary: result.summary });
}
