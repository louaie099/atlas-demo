import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
export const dynamic = "force-dynamic";

import { loadPersistedPlanView } from "@/lib/planning/weekly-plan-service";
import { DAYS_WITH_DATA, CURRENT_WEEK_START } from "@/lib/seed-data";

/**
 * Reads the persisted plan's roster view -- same source
 * /api/planning/weekly-view uses (loadPersistedPlanView), so this route's
 * data can never drift from the Weekly Planning page's. Kept as its own
 * endpoint because the Dashboard (app/page.tsx) only needs Flight
 * Coverage, not Agent Schedule alongside it.
 */
export async function GET() {
  const supabase = getSupabaseServerClient();

  const view = await loadPersistedPlanView(supabase, CURRENT_WEEK_START, DAYS_WITH_DATA);
  if (!view) {
    return NextResponse.json({ plan: null, roster: [], planIssueCount: 0 });
  }

  return NextResponse.json({ plan: view.plan, roster: view.roster, planIssueCount: view.plan.issues.length });
}
