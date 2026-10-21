import { SupabaseClient } from "@supabase/supabase-js";
import {
  POC_DEMO_CONFIG,
  POC_DEMO_EMPLOYEES,
  POC_DEMO_FLIGHTS,
  POC_DEMO_DAYS_WITH_DATA,
  POC_DEMO_WEEK_START,
  POC_DEMO_WEEK_LABEL,
} from "./demo-poc/dataset";
import { computeWeeklyStaffingRequirements } from "./planning/weekly-requirements";
import { buildDraftPlanBundle, persistDraftPlanBundle, planIdForWeek } from "./planning/weekly-plan-service";

/**
 * Wipes and re-seeds every table from lib/demo-poc/dataset.ts — the THIRD,
 * independent, purpose-built dataset for a short live management
 * demonstration (docs/ATLAS_POC_PLAN.md Section 5) — through the exact
 * same buildDraftPlanBundle/persistDraftPlanBundle real engine calls
 * lib/reset-database.ts and lib/reset-small-demo.ts both use. Same
 * philosophy as those files' own doc comments: there is exactly one "what
 * does generating a draft actually do" implementation (lib/planning/
 * weekly-plan-service.ts) — this is demo orchestration around it, never a
 * second seed-only planning implementation.
 *
 * Deliberately NOT a parameterized variant of resetDatabase/
 * resetSmallDemoDatabase: keeping this fully separate means none of the
 * three files has to branch on "which dataset am I seeding," and neither
 * the main dataset's resetDatabase nor the small demo's
 * resetSmallDemoDatabase is touched by this one existing.
 */
export async function resetPocDemoDatabase(supabase: SupabaseClient): Promise<void> {
  // Same FK-safe delete order as resetDatabase/resetSmallDemoDatabase —
  // this is a full wipe, not an overlay: no two of the three datasets are
  // ever meant to coexist in the same database at once.
  await supabase.from("audit_log_entries").delete().neq("id", "");
  await supabase.from("assignment_modifications").delete().neq("id", "");
  await supabase.from("assignments").delete().neq("id", "");
  await supabase.from("weekly_plan_roster_entries").delete().neq("id", "");
  await supabase.from("weekly_plans").delete().neq("id", "");
  await supabase.from("planned_duties").delete().neq("id", "");
  await supabase.from("staffing_requirements").delete().neq("id", "");
  await supabase.from("flights").delete().neq("id", "");
  await supabase.from("employees").delete().neq("id", "");
  // planning_labor_rules / planning_fatigue_config are deliberately NOT wiped: labor rules are configuration, not demo data.

  const { error: empErr } = await supabase.from("employees").insert(POC_DEMO_EMPLOYEES);
  if (empErr) throw new Error(`Seeding PoC demo employees failed: ${empErr.message}`);

  const { error: flightErr } = await supabase.from("flights").insert(POC_DEMO_FLIGHTS);
  if (flightErr) throw new Error(`Seeding PoC demo flights failed: ${flightErr.message}`);

  const requirements = computeWeeklyStaffingRequirements(POC_DEMO_FLIGHTS, POC_DEMO_CONFIG);

  const { error: reqErr } = await supabase.from("staffing_requirements").insert(requirements);
  if (reqErr) throw new Error(`Seeding PoC demo staffing requirements failed: ${reqErr.message}`);

  const planId = planIdForWeek(POC_DEMO_WEEK_START);
  const bundle = buildDraftPlanBundle({
    planId,
    weekStart: POC_DEMO_WEEK_START,
    weekLabel: POC_DEMO_WEEK_LABEL,
    revision: 1,
    flights: POC_DEMO_FLIGHTS,
    employees: POC_DEMO_EMPLOYEES,
    config: POC_DEMO_CONFIG,
    daysOrder: POC_DEMO_DAYS_WITH_DATA,
  });
  await persistDraftPlanBundle(supabase, bundle);

  const totalRequirement = requirements.reduce((sum, r) => sum + r.total_requirement, 0);
  const totalAssigned = bundle.assignments.length;

  const auditEntries = [
    {
      id: "poc-demo-audit-1",
      step_number: 1,
      description: `PoC demo dataset seeded — ${POC_DEMO_EMPLOYEES.length} employees, ${POC_DEMO_FLIGHTS.length} flights across ${POC_DEMO_DAYS_WITH_DATA.length} days (week of ${POC_DEMO_WEEK_START}).`,
    },
    {
      id: "poc-demo-audit-2",
      step_number: 2,
      description: `Draft Weekly Plan ${planId} generated automatically — ${totalAssigned}/${totalRequirement} required positions covered across ${requirements.length} staffing requirements and ${bundle.zoneRequirements.length} T1 Check-in zone/window requirement(s).`,
    },
    {
      id: "poc-demo-audit-3",
      step_number: 3,
      description: `Draft Weekly Plan ${planId} persisted — ${bundle.rosterEntries.length} roster entries, ${bundle.assignments.length} ATLAS-generated assignments.`,
    },
  ];

  const needsConfigFlights = requirements.filter((r) => r.needs_configuration);
  needsConfigFlights.forEach((r, i) => {
    const flight = POC_DEMO_FLIGHTS.find((f) => f.id === r.flight_id)!;
    auditEntries.push({
      id: `poc-demo-audit-config-${i}`,
      step_number: 4 + i,
      description: `Weekly plan validation — ${flight.flight_number} (${flight.airline}) requires configuration before it can be staffed: ${r.reasoning}`,
    });
  });

  const { error: auditErr } = await supabase.from("audit_log_entries").insert(auditEntries);
  if (auditErr) throw new Error(`Seeding PoC demo audit log failed: ${auditErr.message}`);
}
