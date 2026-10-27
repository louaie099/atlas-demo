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

  // Full Qatar Airways QR601 Company Team, so assignments/shift_code can be
  // compared across all 4 real teammates, not just the 3 "broken" ones.
  const qrTeamIds = Array.from(new Set([...targetIds, "mehdi-ouazzani", "nawal-benjelloun", "siham-lahrichi"]));

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

    // Per-day roster status/shift_code for the full QR601 team -- "is this
    // person working today at all", independent of which specific duty (if
    // any) they end up deployed to.
    const rosterByDay = qrTeamIds.map((id) => ({
      id,
      days: bundle.rosterEntries
        .filter((r) => r.employee_id === id)
        .sort((a, b) => a.day_of_week.localeCompare(b.day_of_week))
        .map((r) => ({ day: r.day_of_week, status: r.status, shift_code: r.shift_code })),
    }));

    // Actual DEPLOYMENT to a specific staffing requirement -- this is what
    // the Find Agent / candidates list actually reads. A QR601 Company Team
    // requirement id looks like "req-qr601-<day>-company-team" per the
    // existing convention (see tests/foreign-company-roster-topup.test.ts).
    const qr601Assignments = bundle.assignments.filter(
      (a) => qrTeamIds.includes(a.employee_id) || a.staffing_requirement_id.includes("qr601")
    );

    // Every unfilled_duty issue the draft raised, plus any issue naming one
    // of the 4 QR team members specifically (by employeeId) regardless of
    // type -- in case the explanation is a rest/off-day violation rather
    // than a plain staffing gap.
    const relevantIssues = bundle.plan.issues.filter(
      (i) => i.type === "unfilled_duty" || (i.employeeId && qrTeamIds.includes(i.employeeId))
    );

    bundleResult = {
      totalRosterEntries: bundle.rosterEntries.length,
      staffingGaps: bundle.summary.staffingGaps,
      dutiesAssigned: bundle.summary.dutiesAssigned,
      targetWorkingDays: targetIds.map((id) => ({
        id,
        rosterEntries: bundle.rosterEntries.filter((r) => r.employee_id === id).length,
        workingDays: bundle.rosterEntries.filter((r) => r.employee_id === id && r.shift_code).length,
      })),
      rosterByDay,
      qr601Assignments,
      relevantIssues,
      allUnfilledDutyIssues: bundle.plan.issues.filter((i) => i.type === "unfilled_duty"),
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
