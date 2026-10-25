import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
export const dynamic = "force-dynamic";

import { buildDraftPlanBundle, lookupPriorWeekBoundaryContext, planIdForWeek } from "@/lib/planning/weekly-plan-service";
import { resolveEffectiveConfig } from "@/lib/planning/rules-service";
import { DAYS_WITH_DATA } from "@/lib/seed-data";
import { weekLabelFor } from "@/lib/flight-date";
import { isGenerationDrivenPopulation } from "@/lib/planning/workforce-pools";
import { Employee, Flight, WeeklyPlan } from "@/lib/types";

/**
 * TEMPORARY DIAGNOSTIC ROUTE -- not linked from any UI, read-only (no
 * writes), added 2026-10-25 to find why newly-added employees (via bulk
 * import or manual add) never get rostered by Make Planning even though
 * buildDraftPlanBundle, called directly offline with the exact same
 * employee/flight/config data, produces a correct result. This re-runs
 * the EXACT same inputs regenerateDraftPlan would build (the real
 * employees select, the real prior-week boundary context) and reports,
 * for a target list of employee ids, what the raw DB row looked like and
 * what buildDraftPlanBundle actually produced for them -- so the gap
 * between "offline repro" and "live behavior" is visible without Vercel
 * log access. DELETE THIS ROUTE once the discrepancy is found.
 */
export async function GET(req: Request) {
  const supabase = getSupabaseServerClient();
  const url = new URL(req.url);
  const weekStart = url.searchParams.get("week_start") ?? "2026-10-19";
  const targetIds = (url.searchParams.get("ids") ?? "sofia-el-mansouri,anas-berrada,mouna-sqalli").split(",");

  const config = await resolveEffectiveConfig(supabase);
  const weekLabel = weekLabelFor(weekStart);
  const planId = planIdForWeek(weekStart);

  const [{ data: flights, error: flightsErr }, { data: employeesRaw, error: empErr }, { data: planRows, error: planErr }] = await Promise.all([
    supabase.from("flights").select("*").eq("week_start", weekStart),
    supabase.from("employees").select("*"),
    supabase.from("weekly_plans").select("*").eq("id", planId),
  ]);
  if (flightsErr || empErr || planErr) {
    return NextResponse.json({ error: (flightsErr || empErr || planErr)!.message }, { status: 500 });
  }

  const employees = (employeesRaw ?? []) as Employee[];
  const rawTargetRows = employees
    .filter((e) => targetIds.includes(e.id))
    .map((e) => ({
      id: e.id,
      active: e.active,
      assignment: e.assignment,
      skills: e.skills,
      is_duty_officer: e.is_duty_officer,
      shift_start: e.shift_start,
      shift_code: e.shift_code,
      weekly_shifts_len: e.weekly_shifts?.length ?? null,
      off_days: e.off_days,
      isGenerationDriven: isGenerationDrivenPopulation(e),
      typeofActive: typeof e.active,
    }));

  const existingPlan = planRows?.[0] as WeeklyPlan | undefined;

  let prior: Awaited<ReturnType<typeof lookupPriorWeekBoundaryContext>>;
  let priorErr: string | null = null;
  try {
    prior = await lookupPriorWeekBoundaryContext(supabase, weekStart, DAYS_WITH_DATA, employees);
  } catch (err) {
    priorErr = err instanceof Error ? err.message : String(err);
    prior = undefined;
  }

  let bundleResult: unknown = null;
  let bundleErr: string | null = null;
  try {
    const bundle = buildDraftPlanBundle({
      planId,
      weekStart,
      weekLabel,
      revision: (existingPlan?.revision ?? 0) + 1,
      flights: (flights ?? []) as Flight[],
      employees,
      config,
      daysOrder: DAYS_WITH_DATA,
      priorWeekBoundaryContext: prior?.context,
      priorPlanRosterEntries: prior?.priorRosterEntries,
      priorWeekPublished: prior?.published,
    });
    bundleResult = {
      totalRosterEntries: bundle.rosterEntries.length,
      staffingGaps: bundle.summary.staffingGaps,
      dutiesAssigned: bundle.summary.dutiesAssigned,
      targetWorkingDays: targetIds.map((id) => ({
        id,
        rosterEntries: bundle.rosterEntries.filter((r) => r.employee_id === id).length,
        workingDays: bundle.rosterEntries.filter((r) => r.employee_id === id && r.shift_code).length,
      })),
    };
  } catch (err) {
    bundleErr = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
  }

  return NextResponse.json(
    {
      employeeCount: employees.length,
      rawTargetRows,
      priorErr,
      priorHasContext: Boolean(prior),
      priorRosterEntriesCount: prior?.priorRosterEntries?.length ?? null,
      priorPublished: prior?.published ?? null,
      bundleResult,
      bundleErr,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
