import { SupabaseClient } from "@supabase/supabase-js";
import {
  SMALL_DEMO_CONFIG,
  SMALL_DEMO_EMPLOYEES,
  SMALL_DEMO_FLIGHTS,
  SMALL_DEMO_DAYS_WITH_DATA,
  SMALL_DEMO_WEEK_START,
  SMALL_DEMO_WEEK_LABEL,
} from "./demo-small/dataset";
import { computeWeeklyStaffingRequirements } from "./planning/weekly-requirements";
import { buildDraftPlanBundle, persistDraftPlanBundle, planIdForWeek } from "./planning/weekly-plan-service";

/**
 * Wipes and re-seeds every table from lib/demo-small/dataset.ts — the
 * SEPARATE, small (~22-employee) UI/manual-testing dataset — through the
 * exact same buildDraftPlanBundle/persistDraftPlanBundle real engine
 * calls lib/reset-database.ts uses for the main dataset. Same philosophy
 * as that file's own doc comment: there is exactly one "what does
 * generating a draft actually do" implementation (lib/planning/
 * weekly-plan-service.ts) — this is demo orchestration around it, never a
 * second seed-only planning implementation.
 *
 * Deliberately NOT a parameterized variant of resetDatabase: that
 * function's audit-log step hardcodes AT201-specific reasoning (a
 * protected, scenario-critical flight that only exists in the main
 * dataset). Keeping this fully separate means neither file has to branch
 * on "which dataset am I seeding," and the main dataset's resetDatabase
 * (and everything that depends on its exact behavior — scripts/seed.ts,
 * app/api/reset/route.ts, the existing test suite) is completely
 * untouched by this one existing.
 */
export async function resetSmallDemoDatabase(supabase: SupabaseClient): Promise<void> {
  // Same FK-safe delete order as resetDatabase — this is a full wipe, not
  // an overlay: the small demo and the main dataset are never meant to
  // coexist in the same database at once.
  await supabase.from("audit_log_entries").delete().neq("id", "");
  await supabase.from("assignment_modifications").delete().neq("id", "");
  await supabase.from("assignments").delete().neq("id", "");
  await supabase.from("weekly_plan_roster_entries").delete().neq("id", "");
  await supabase.from("weekly_plans").delete().neq("id", "");
  await supabase.from("planned_duties").delete().neq("id", "");
  await supabase.from("staffing_requirements").delete().neq("id", "");
  await supabase.from("flights").delete().neq("id", "");
  await supabase.from("employees").delete().neq("id", "");
  await supabase.from("planning_labor_rules").delete().neq("id", "");
  await supabase.from("planning_fatigue_config").delete().neq("id", "");

  const { error: empErr } = await supabase.from("employees").insert(SMALL_DEMO_EMPLOYEES);
  if (empErr) throw new Error(`Seeding small-demo employees failed: ${empErr.message}`);

  const { error: flightErr } = await supabase.from("flights").insert(SMALL_DEMO_FLIGHTS);
  if (flightErr) throw new Error(`Seeding small-demo flights failed: ${flightErr.message}`);

  const requirements = computeWeeklyStaffingRequirements(SMALL_DEMO_FLIGHTS, SMALL_DEMO_CONFIG);

  const { error: reqErr } = await supabase.from("staffing_requirements").insert(requirements);
  if (reqErr) throw new Error(`Seeding small-demo staffing requirements failed: ${reqErr.message}`);

  const planId = planIdForWeek(SMALL_DEMO_WEEK_START);
  const bundle = buildDraftPlanBundle({
    planId,
    weekStart: SMALL_DEMO_WEEK_START,
    weekLabel: SMALL_DEMO_WEEK_LABEL,
    revision: 1,
    flights: SMALL_DEMO_FLIGHTS,
    employees: SMALL_DEMO_EMPLOYEES,
    config: SMALL_DEMO_CONFIG,
    daysOrder: SMALL_DEMO_DAYS_WITH_DATA,
  });
  await persistDraftPlanBundle(supabase, bundle);

  const totalRequirement = requirements.reduce((sum, r) => sum + r.total_requirement, 0);
  const totalAssigned = bundle.assignments.length;

  const auditEntries = [
    {
      id: "small-demo-audit-1",
      step_number: 1,
      description: `Small demo dataset seeded — ${SMALL_DEMO_EMPLOYEES.length} employees, ${SMALL_DEMO_FLIGHTS.length} flights across ${SMALL_DEMO_DAYS_WITH_DATA.length} days (week of ${SMALL_DEMO_WEEK_START}).`,
    },
    {
      id: "small-demo-audit-2",
      step_number: 2,
      description: `Draft Weekly Plan ${planId} generated automatically — ${totalAssigned}/${totalRequirement} required positions covered across ${requirements.length} staffing requirements and ${bundle.zoneRequirements.length} T1 Check-in zone/window requirement(s).`,
    },
    {
      id: "small-demo-audit-3",
      step_number: 3,
      description: `Draft Weekly Plan ${planId} persisted — ${bundle.rosterEntries.length} roster entries, ${bundle.assignments.length} ATLAS-generated assignments.`,
    },
  ];

  const needsConfigFlights = requirements.filter((r) => r.needs_configuration);
  needsConfigFlights.forEach((r, i) => {
    const flight = SMALL_DEMO_FLIGHTS.find((f) => f.id === r.flight_id)!;
    auditEntries.push({
      id: `small-demo-audit-config-${i}`,
      step_number: 4 + i,
      description: `Weekly plan validation — ${flight.flight_number} (${flight.airline}) requires configuration before it can be staffed: ${r.reasoning}`,
    });
  });

  const { error: auditErr } = await supabase.from("audit_log_entries").insert(auditEntries);
  if (auditErr) throw new Error(`Seeding small-demo audit log failed: ${auditErr.message}`);
}
