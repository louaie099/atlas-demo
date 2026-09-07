import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
export const dynamic = "force-dynamic";

import { loadPersistedPlanView } from "@/lib/planning/weekly-plan-service";
import { DAYS_WITH_DATA, CURRENT_WEEK_START } from "@/lib/seed-data";

/**
 * Exposes the persisted WeeklyPlan's own record (status, revision,
 * generated_at/published_at, frozen issues/configuration_issues) -- no
 * longer a live recomputation. Returns `plan: null` if none has been
 * generated yet for the current week. Not wired into the Weekly Planning
 * page's UI (see /api/planning/weekly-view for the full roster/schedule
 * view that page actually uses); this is for standalone plan-metadata
 * inspection.
 */
export async function GET() {
  const supabase = getSupabaseServerClient();

  const view = await loadPersistedPlanView(supabase, CURRENT_WEEK_START, DAYS_WITH_DATA);
  return NextResponse.json({ plan: view?.plan ?? null });
}
