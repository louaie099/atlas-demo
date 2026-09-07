import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
export const dynamic = "force-dynamic";

import { loadPersistedPlanView } from "@/lib/planning/weekly-plan-service";
import { DAYS_WITH_DATA, CURRENT_WEEK_START } from "@/lib/seed-data";

/**
 * Reads the persisted plan's schedule view -- same source
 * /api/planning/weekly-view uses (loadPersistedPlanView). Kept as its own
 * endpoint for any standalone consumer of just the Agent Schedule view.
 */
export async function GET() {
  const supabase = getSupabaseServerClient();

  const view = await loadPersistedPlanView(supabase, CURRENT_WEEK_START, DAYS_WITH_DATA);
  if (!view) {
    return NextResponse.json({ schedule: [] });
  }

  return NextResponse.json({ schedule: view.schedule });
}
