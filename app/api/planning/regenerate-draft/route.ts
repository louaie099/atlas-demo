import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
export const dynamic = "force-dynamic";

import { regenerateDraftPlan } from "@/lib/planning/weekly-plan-service";
import { CONFIG, DAYS_WITH_DATA } from "@/lib/seed-data";

/**
 * Regenerate Draft. Only valid on an existing DRAFT plan (409 if
 * published or missing) and only when it carries NO human modification
 * for its current revision (409, per the confirmed correction: "no silent
 * loss, no pretending manual work survived when it did not"). A future
 * explicit "Regenerate and discard manual modifications" action is not
 * implemented here.
 */
export async function POST(req: Request) {
  const supabase = getSupabaseServerClient();
  const { planId } = await req.json().catch(() => ({}));

  if (!planId) {
    return NextResponse.json({ error: "planId is required" }, { status: 400 });
  }

  const result = await regenerateDraftPlan(supabase, planId, DAYS_WITH_DATA, CONFIG);
  if ("blocked" in result) {
    return NextResponse.json({ error: result.reason }, { status: 409 });
  }

  return NextResponse.json({ plan: result.plan });
}
