import { SupabaseClient } from "@supabase/supabase-js";
import {
  CONFIG,
  EMPLOYEES,
  FLIGHTS,
  INITIAL_AT201_ASSIGNEES,
  INITIAL_PLANNED_DUTY,
} from "./seed-data";
import { computeBoardingRequirement, computeCheckinRequirement } from "./demand-forecast";

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

  const at201 = FLIGHTS.find((f) => f.id === "at201")!;
  const at535 = FLIGHTS.find((f) => f.id === "at535")!;

  const boardingReq = computeBoardingRequirement(at201);
  const checkinReq = computeCheckinRequirement(at535, CONFIG);

  const requirements = [
    { id: "req-at201-boarding", flight_id: at201.id, ...boardingReq },
    { id: "req-at535-checkin", flight_id: at535.id, ...checkinReq },
  ];

  const { error: reqErr } = await supabase.from("staffing_requirements").insert(requirements);
  if (reqErr) throw new Error(`Seeding staffing requirements failed: ${reqErr.message}`);

  const initialAssignments = INITIAL_AT201_ASSIGNEES.map((employeeId, i) => ({
    id: `assign-at201-${i}`,
    staffing_requirement_id: "req-at201-boarding",
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

  const { error: auditErr } = await supabase.from("audit_log_entries").insert([
    {
      id: "audit-1",
      step_number: 1,
      description: `Weekly plan validated — AT535 Check-in/ACE requirement computed: baseline ${checkinReq.baseline_requirement} + overbooking reinforcement ${checkinReq.additional_requirement} = ${checkinReq.total_requirement} (gap: ${checkinReq.total_requirement - 4})`,
    },
    {
      id: "audit-2",
      step_number: 2,
      description: `Weekly plan validated — AT201 Boarding gap detected (${INITIAL_AT201_ASSIGNEES.length}/${boardingReq.total_requirement}, fixed rule)`,
    },
  ]);
  if (auditErr) throw new Error(`Seeding audit log failed: ${auditErr.message}`);
}
