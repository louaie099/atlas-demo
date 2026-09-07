import { SupabaseClient } from "@supabase/supabase-js";
import {
  CONFIG,
  EMPLOYEES,
  FLIGHTS,
  INITIAL_PLANNED_DUTY,
  DAYS_WITH_DATA,
  CURRENT_WEEK_START,
  CURRENT_WEEK_LABEL,
} from "./seed-data";
import { computeWeeklyStaffingRequirements } from "./planning/weekly-requirements";
import { buildDraftPlanBundle, persistDraftPlanBundle, planIdForWeek } from "./planning/weekly-plan-service";

/**
 * Wipes and re-seeds every table from lib/seed-data.ts, THEN generates and
 * persists a fresh Draft Weekly Plan through the exact same
 * buildDraftPlanBundle/persistDraftPlanBundle steps a normal Generate
 * Draft API call uses (lib/planning/weekly-plan-service.ts) -- Reset Demo
 * is demo orchestration around that one real service, never a second
 * seed-only planning implementation. This is also why the old hand-
 * scripted "confirm these specific employees to AT201/foreign-company
 * flights" seeding is gone entirely: the real generator now produces (and
 * persists) every normal assignment on its own, honoring the exact same
 * headcount/overlap invariants tests/assignment-invariants.test.ts checks
 * directly against the generator.
 *
 * Used by both the standalone seed script and the /api/reset route, so
 * there is exactly one implementation of "what a fresh demo looks like."
 */
export async function resetDatabase(supabase: SupabaseClient): Promise<void> {
  // Delete in FK-safe order. New tables (assignment_modifications,
  // weekly_plan_roster_entries, weekly_plans) are wiped alongside the
  // existing ones -- a reset genuinely starts over, no plan survives it.
  await supabase.from("audit_log_entries").delete().neq("id", "");
  await supabase.from("assignment_modifications").delete().neq("id", "");
  await supabase.from("assignments").delete().neq("id", "");
  await supabase.from("weekly_plan_roster_entries").delete().neq("id", "");
  await supabase.from("weekly_plans").delete().neq("id", "");
  await supabase.from("planned_duties").delete().neq("id", "");
  await supabase.from("staffing_requirements").delete().neq("id", "");
  await supabase.from("flights").delete().neq("id", "");
  await supabase.from("employees").delete().neq("id", "");

  const { error: empErr } = await supabase.from("employees").insert(EMPLOYEES);
  if (empErr) throw new Error(`Seeding employees failed: ${empErr.message}`);

  const { error: flightErr } = await supabase.from("flights").insert(FLIGHTS);
  if (flightErr) throw new Error(`Seeding flights failed: ${flightErr.message}`);

  const requirements = computeWeeklyStaffingRequirements(FLIGHTS, CONFIG);

  const { error: reqErr } = await supabase.from("staffing_requirements").insert(requirements);
  if (reqErr) throw new Error(`Seeding staffing requirements failed: ${reqErr.message}`);

  const { error: dutyErr } = await supabase.from("planned_duties").insert([
    {
      id: "duty-nadia-carepoint",
      employee_id: INITIAL_PLANNED_DUTY.employee_id,
      task: INITIAL_PLANNED_DUTY.task,
      planned_start: INITIAL_PLANNED_DUTY.planned_start,
      status: "planned",
    },
  ]);
  if (dutyErr) throw new Error(`Seeding planned duties failed: ${dutyErr.message}`);

  // Generate Draft, through the real service -- same bundle-building step
  // the /api/planning/generate-draft route calls. This is what actually
  // creates the demo's WeeklyPlan, its full plan-scoped roster, and every
  // normal atlas_generated Assignment row.
  const planId = planIdForWeek(CURRENT_WEEK_START);
  const bundle = buildDraftPlanBundle({
    planId,
    weekStart: CURRENT_WEEK_START,
    weekLabel: CURRENT_WEEK_LABEL,
    revision: 1,
    flights: FLIGHTS,
    employees: EMPLOYEES,
    config: CONFIG,
    daysOrder: DAYS_WITH_DATA,
  });
  await persistDraftPlanBundle(supabase, bundle);

  const at535Requirement = requirements.find((r) => r.flight_id === "at535" && r.role === "Check-in")!;
  const at201Boarding = bundle.assignments.filter((a) => {
    const req = requirements.find((r) => r.id === a.staffing_requirement_id);
    return req?.flight_id === "at201" && req.role === "Boarding";
  }).length;
  const at201Gate = bundle.assignments.filter((a) => {
    const req = requirements.find((r) => r.id === a.staffing_requirement_id);
    return req?.flight_id === "at201" && req.role === "Gate";
  }).length;
  const at201Profiling = bundle.assignments.filter((a) => {
    const req = requirements.find((r) => r.id === a.staffing_requirement_id);
    return req?.flight_id === "at201" && req.role === "Profiling";
  }).length;
  const at201BoardingReq = requirements.find((r) => r.flight_id === "at201" && r.role === "Boarding")!;
  const at201GateReq = requirements.find((r) => r.flight_id === "at201" && r.role === "Gate")!;
  const at201ProfilingReq = requirements.find((r) => r.flight_id === "at201" && r.role === "Profiling")!;

  const auditEntries = [
    {
      id: "audit-1",
      step_number: 1,
      description: `Weekly plan validated — AT535 Check-in requirement computed: baseline ${at535Requirement.baseline_requirement} + overbooking reinforcement ${at535Requirement.additional_requirement} = ${at535Requirement.total_requirement} (gap: ${at535Requirement.total_requirement - 4})`,
    },
    {
      id: "audit-2",
      step_number: 2,
      // Coverage numbers now come directly from the real generated bundle
      // (bundle.assignments) -- never a hardcoded expectation of what the
      // generator "should" produce.
      description: `Draft Weekly Plan ${planId} generated automatically — AT201 coverage: Boarding ${at201Boarding}/${at201BoardingReq.total_requirement}, Gate ${at201Gate}/${at201GateReq.total_requirement}, Profiling ${at201Profiling}/${at201ProfilingReq.total_requirement}.`,
    },
    {
      id: "audit-3",
      step_number: 3,
      description: `Draft Weekly Plan ${planId} persisted — ${bundle.rosterEntries.length} roster entries, ${bundle.assignments.length} ATLAS-generated assignments across ${DAYS_WITH_DATA.length} days.`,
    },
  ];

  const needsConfigFlights = requirements.filter((r) => r.needs_configuration);
  needsConfigFlights.forEach((r, i) => {
    const flight = FLIGHTS.find((f) => f.id === r.flight_id)!;
    auditEntries.push({
      id: `audit-config-${i}`,
      step_number: 4 + i,
      description: `Weekly plan validation — ${flight.flight_number} (${flight.airline}) requires configuration before it can be staffed: ${r.reasoning}`,
    });
  });

  const { error: auditErr } = await supabase.from("audit_log_entries").insert(auditEntries);
  if (auditErr) throw new Error(`Seeding audit log failed: ${auditErr.message}`);
}
