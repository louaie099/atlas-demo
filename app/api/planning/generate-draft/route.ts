import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
export const dynamic = "force-dynamic";

import { generateDraftPlan } from "@/lib/planning/weekly-plan-service";
import { CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_LABEL, CURRENT_WEEK_START } from "@/lib/seed-data";

/**
 * Generate Draft. Creates and persists a new WeeklyPlan for the current
 * week -- refuses (409) if one already exists (draft or published); use
 * Regenerate to replace an existing draft. This is the only path that
 * creates a plan from nothing; Reset Demo calls the same underlying
 * service function directly (lib/reset-database.ts), never a parallel
 * implementation.
 */
export async function POST() {
  const supabase = getSupabaseServerClient();

  const result = await generateDraftPlan(supabase, CURRENT_WEEK_START, CURRENT_WEEK_LABEL, DAYS_WITH_DATA, CONFIG);
  if ("blocked" in result) {
    return NextResponse.json({ error: result.reason }, { status: 409 });
  }

  return NextResponse.json({ plan: result.plan });
}
