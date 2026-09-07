import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
export const dynamic = "force-dynamic";

import { publishPlan } from "@/lib/planning/weekly-plan-service";

/**
 * Publish. Does not generate or change any assignment/roster row -- see
 * lib/planning/weekly-plan-service.ts's publishPlan doc comment. Only
 * valid on a draft plan (409 otherwise). Records an audit-log entry, same
 * pattern the rest of the app uses for a human-attributed action.
 */
export async function POST(req: Request) {
  const supabase = getSupabaseServerClient();
  const { planId } = await req.json().catch(() => ({}));

  if (!planId) {
    return NextResponse.json({ error: "planId is required" }, { status: 400 });
  }

  const result = await publishPlan(supabase, planId);
  if ("blocked" in result) {
    return NextResponse.json({ error: result.reason }, { status: 409 });
  }

  const { data: lastStep } = await supabase
    .from("audit_log_entries")
    .select("step_number")
    .order("step_number", { ascending: false })
    .limit(1)
    .single();
  const nextStep = (lastStep?.step_number ?? 0) + 1;

  await supabase.from("audit_log_entries").insert({
    id: `audit-${nextStep}`,
    step_number: nextStep,
    description: `Weekly plan ${planId} published by Mohammed Alaoui — this revision (${result.plan.revision}) is now the operational baseline.`,
  });

  return NextResponse.json({ plan: result.plan });
}
