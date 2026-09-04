import { SupabaseClient } from "@supabase/supabase-js";
import {
  CONFIG,
  EMPLOYEES,
  FLIGHTS,
  INITIAL_AT201_ASSIGNEES,
  INITIAL_PLANNED_DUTY,
  DAYS_WITH_DATA,
} from "./seed-data";
import { CONFIGURED_COMPANIES } from "./company-config";
import { planForeignCompanyDay } from "./foreign-shift-planning";
import { computeWeeklyStaffingRequirements } from "./planning/weekly-requirements";

/**
 * Wipes and re-seeds every table from lib/seed-data.ts. Used by both the
 * standalone seed script and the /api/reset route, so there is exactly one
 * implementation of "what a fresh demo looks like."
 */
export async function resetDatabase(supabase: SupabaseClient): Promise<void> {
  // Delete in FK-safe order.
  await supabase.from("audit_log_entries").delete().neq("id", "");
  await supabase.from("assignments").delete().neq("id", "");
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

  // AT201 now produces multiple concurrent requirements (Gate, Boarding,
  // Profiling — Europe/Schengen, standard aircraft), not one — the
  // scripted initial assignees are specifically Boarding agents, so find
  // that role explicitly rather than the first requirement for the flight.
  const at201BoardingRequirement = requirements.find((r) => r.flight_id === "at201" && r.role === "Boarding")!;
  const at201GateRequirement = requirements.find((r) => r.flight_id === "at201" && r.role === "Gate")!;
  const at201ProfilingRequirement = requirements.find((r) => r.flight_id === "at201" && r.role === "Profiling")!;
  const at535Requirement = requirements.find((r) => r.flight_id === "at535" && r.role === "Check-in")!;

  const initialAssignments = INITIAL_AT201_ASSIGNEES.map((employeeId, i) => ({
    id: `assign-at201-${i}`,
    staffing_requirement_id: at201BoardingRequirement.id,
    employee_id: employeeId,
  }));

  // Employees whose current `assignment` is a foreign company get a real
  // Assignment for EVERY flight that company actually operates on each
  // day — derived from the flight schedule itself, never fabricated, and
  // capable of multiple same-company flights on one date (each gets its
  // own Assignment row, tied to its own requirement). Days with no flight
  // for that company get no Assignment row at all — the employee simply
  // follows their normal fallback shift that day (already reflected in
  // seed-data.ts's applyForeignCompanyRoster).
  const foreignAssignmentEmployees = EMPLOYEES.filter((e) => CONFIGURED_COMPANIES.includes(e.assignment));
  const foreignCommitmentAssignments: { id: string; staffing_requirement_id: string; employee_id: string }[] = [];

  for (const emp of foreignAssignmentEmployees) {
    for (const day of DAYS_WITH_DATA) {
      // Real bug fix: if the employee is OFF that day (per their own
      // weekly_shifts, which seed-data.ts's applyForeignCompanyRoster
      // already leaves untouched on OFF days), skip entirely — a day off
      // must not be silently overridden by a fabricated company
      // commitment. Previously this loop ignored off-status altogether.
      const dayEntry = emp.weekly_shifts.find((s) => s.day_of_week === day);
      if (dayEntry?.status === "off") continue;

      const plan = planForeignCompanyDay(emp.assignment, day, FLIGHTS);
      if (!plan || !plan.shiftCode) continue; // no flight that day, or no compatible shift — no commitment to record

      for (const { flight } of plan.windows) {
        const requirement = requirements.find((r) => r.flight_id === flight.id && !r.needs_configuration);
        if (!requirement) continue;

        foreignCommitmentAssignments.push({
          id: `assign-foreign-${emp.id}-${flight.id}`,
          staffing_requirement_id: requirement.id,
          employee_id: emp.id,
        });
      }
    }
  }

  const { error: assignErr } = await supabase
    .from("assignments")
    .insert([...initialAssignments, ...foreignCommitmentAssignments]);
  if (assignErr) throw new Error(`Seeding assignments failed: ${assignErr.message}`);

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

  const auditEntries = [
    {
      id: "audit-1",
      step_number: 1,
      description: `Weekly plan validated — AT535 Check-in requirement computed: baseline ${at535Requirement.baseline_requirement} + overbooking reinforcement ${at535Requirement.additional_requirement} = ${at535Requirement.total_requirement} (gap: ${at535Requirement.total_requirement - 4})`,
    },
    {
      id: "audit-2",
      step_number: 2,
      // AT201 (Europe/Schengen, standard aircraft) now has three concurrent
      // RAM requirements — Gate, Boarding, Profiling — not one merged
      // number. The scripted assignees cover Boarding only, so describe
      // each role's actual initial coverage honestly rather than asserting
      // a single "gap" that may not even be true for the role they cover.
      description: `Weekly plan validated — AT201 initial coverage: Boarding ${INITIAL_AT201_ASSIGNEES.length}/${at201BoardingRequirement.total_requirement}, Gate 0/${at201GateRequirement.total_requirement}, Profiling 0/${at201ProfilingRequirement.total_requirement} (operation rule) — Gate and Profiling remain unfilled gaps.`,
    },
  ];

  const needsConfigFlights = requirements.filter((r) => r.needs_configuration);
  needsConfigFlights.forEach((r, i) => {
    const flight = FLIGHTS.find((f) => f.id === r.flight_id)!;
    auditEntries.push({
      id: `audit-config-${i}`,
      step_number: 3 + i,
      description: `Weekly plan validation — ${flight.flight_number} (${flight.airline}) requires configuration before it can be staffed: ${r.reasoning}`,
    });
  });

  const { error: auditErr } = await supabase.from("audit_log_entries").insert(auditEntries);
  if (auditErr) throw new Error(`Seeding audit log failed: ${auditErr.message}`);
}
