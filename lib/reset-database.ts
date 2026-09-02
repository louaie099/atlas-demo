import { SupabaseClient } from "@supabase/supabase-js";
import {
  CONFIG,
  EMPLOYEES,
  FLIGHTS,
  INITIAL_AT201_ASSIGNEES,
  INITIAL_PLANNED_DUTY,
} from "./seed-data";
import { computeCheckinRequirement } from "./demand-forecast";
import { classifyRamBoardingRequirement, missingOperationRuleRequirement } from "./operation-rules";
import { classifyCompanyRequirement, missingCompanyConfigRequirement } from "./company-config";
import { Flight, StaffingRequirement } from "./types";

/**
 * Classifies a single flight into its staffing requirement(s), using the
 * same rule modules the rest of the app uses — never a special case here.
 * RAM/atlas_managed flights go through operation-rules.ts (Boarding) or
 * demand-forecast.ts (Check-in/ACE, AT535 only, by design). Self-managed
 * (foreign carrier) flights go through company-config.ts. A flight with
 * no matching rule/config comes back with needs_configuration: true —
 * never a guessed number.
 */
function classifyFlight(flight: Flight): Omit<StaffingRequirement, "id" | "flight_id"> {
  if (flight.operator_type === "self_managed") {
    return classifyCompanyRequirement(flight) ?? missingCompanyConfigRequirement(flight);
  }

  // atlas_managed: AT535 is the one demand-forecast (Check-in/ACE) case in
  // the seed data; every other RAM flight goes through the Boarding
  // operation-rule table.
  if (flight.id === "at535") {
    return computeCheckinRequirement(flight, CONFIG);
  }

  return classifyRamBoardingRequirement(flight) ?? missingOperationRuleRequirement(flight);
}

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

  const requirements = FLIGHTS.map((flight) => {
    const classified = classifyFlight(flight);
    const requirementId = `req-${flight.id}-${classified.role.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    return { id: requirementId, flight_id: flight.id, ...classified };
  });

  const { error: reqErr } = await supabase.from("staffing_requirements").insert(requirements);
  if (reqErr) throw new Error(`Seeding staffing requirements failed: ${reqErr.message}`);

  const at201Requirement = requirements.find((r) => r.flight_id === "at201")!;
  const at535Requirement = requirements.find((r) => r.flight_id === "at535")!;

  const initialAssignments = INITIAL_AT201_ASSIGNEES.map((employeeId, i) => ({
    id: `assign-at201-${i}`,
    staffing_requirement_id: at201Requirement.id,
    employee_id: employeeId,
  }));

  const { error: assignErr } = await supabase.from("assignments").insert(initialAssignments);
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
      description: `Weekly plan validated — AT535 Check-in/ACE requirement computed: baseline ${at535Requirement.baseline_requirement} + overbooking reinforcement ${at535Requirement.additional_requirement} = ${at535Requirement.total_requirement} (gap: ${at535Requirement.total_requirement - 4})`,
    },
    {
      id: "audit-2",
      step_number: 2,
      description: `Weekly plan validated — AT201 Boarding gap detected (${INITIAL_AT201_ASSIGNEES.length}/${at201Requirement.total_requirement}, operation rule)`,
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
