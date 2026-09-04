import { describe, it, expect } from "vitest";
import { generateDutiesForDay } from "../lib/planning/duty-generation";
import { CONFIG } from "../lib/seed-data";
import { Employee, Flight, StaffingRequirement, Assignment } from "../lib/types";

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "emp", name: "Test", skills: ["Boarding"], assignment: "General T1 Pool",
    shift_code: "AP01", shift_start: "13:45", shift_end: "22:45", rest_before_shift_hours: 12,
    weekly_hours: 10, is_duty_officer: false, off_days: [], foreign_company_authorizations: [],
    active: true, weekly_shifts: [{ day_of_week: "Wednesday", shift_code: "AP01", status: "working" }],
    ...overrides,
  };
}

function makeFlight(overrides: Partial<Flight>): Flight {
  return {
    id: "f1", flight_number: "AT100", airline: "Royal Air Maroc", route: "CMN → X",
    origin: "CMN", destination: "X", aircraft: "Boeing 737-800", equipment_code: null,
    registration: null, callsign: null, terminal: "T1", scheduled_departure: "14:00",
    scheduled_arrival: null, gate: null, boarding_window_start: "13:50", boarding_window_end: "14:20",
    status: "scheduled", booking_pressure: "normal", day_of_week: "Wednesday",
    operator_type: "atlas_managed", destination_category: "Europe/Schengen",
    ...overrides,
  };
}

function makeRequirement(overrides: Partial<StaffingRequirement>): StaffingRequirement {
  return {
    id: "r1", flight_id: "f1", role: "Boarding", baseline_requirement: 1, additional_requirement: 0,
    total_requirement: 1, source: "fixed_rule", reasoning: "", needs_configuration: false,
    ...overrides,
  };
}

describe("generateDutiesForDay", () => {
  it("assigns a qualified, rostered employee to a duty", () => {
    const flight = makeFlight({});
    const requirement = makeRequirement({});
    const employee = makeEmployee({ id: "e1" });

    const { duties, unfilled } = generateDutiesForDay("Wednesday", [requirement], [flight], [employee], [], [], CONFIG);
    expect(duties).toHaveLength(1);
    expect(duties[0].employeeId).toBe("e1");
    expect(unfilled).toHaveLength(0);
  });

  it("never double-books an employee across two overlapping duties the same day", () => {
    // T-1h windows: flightA (14:00 departure) -> 13:00-14:00, flightB
    // (14:30 departure) -> 13:30-14:30 — partial overlap, 13:30-14:00.
    const flightA = makeFlight({ id: "a", scheduled_departure: "14:00" });
    const flightB = makeFlight({ id: "b", scheduled_departure: "14:30" }); // overlaps A
    const reqA = makeRequirement({ id: "ra", flight_id: "a", total_requirement: 1 });
    const reqB = makeRequirement({ id: "rb", flight_id: "b", total_requirement: 1 });

    // Only one qualified, rostered employee exists.
    const employee = makeEmployee({ id: "only-one" });

    const { duties, unfilled } = generateDutiesForDay(
      "Wednesday",
      [reqA, reqB],
      [flightA, flightB],
      [employee],
      [],
      [],
      CONFIG
    );
    // Assigned to exactly one of the two (the earlier by departure time), the other is left unfilled
    expect(duties).toHaveLength(1);
    expect(unfilled).toHaveLength(1);
  });

  it("leaves a requirement unfilled (not fabricated) when no rostered employee is qualified", () => {
    const flight = makeFlight({});
    const requirement = makeRequirement({ role: "Boarding" });
    const unqualified = makeEmployee({ id: "e1", skills: ["Gate"] });

    const { duties, unfilled } = generateDutiesForDay("Wednesday", [requirement], [flight], [unqualified], [], [], CONFIG);
    expect(duties).toHaveLength(0);
    expect(unfilled).toEqual([{ dayOfWeek: "Wednesday", requirementId: "r1", role: "Boarding", stillNeeded: 1 }]);
  });

  it("never assigns an employee with no roster for that day at all", () => {
    const flight = makeFlight({});
    const requirement = makeRequirement({});
    const notRostered = makeEmployee({
      id: "e1",
      shift_code: null,
      shift_start: null,
      shift_end: null,
      weekly_shifts: [],
    });

    const { duties } = generateDutiesForDay("Wednesday", [requirement], [flight], [notRostered], [], [], CONFIG);
    expect(duties).toHaveLength(0);
  });

  it("accounts for already-existing real Assignment rows when deciding how many more are needed", () => {
    const flight = makeFlight({});
    const requirement = makeRequirement({ total_requirement: 2 });
    const alreadyAssigned: Assignment = { id: "a1", staffing_requirement_id: "r1", employee_id: "existing-1", assigned_at: "" };
    const newCandidate = makeEmployee({ id: "e2" });

    const { duties, unfilled } = generateDutiesForDay(
      "Wednesday",
      [requirement],
      [flight],
      [newCandidate],
      [],
      [alreadyAssigned],
      CONFIG
    );
    expect(duties).toHaveLength(1); // only 1 more needed, since 1 of 2 is already covered
    expect(unfilled).toHaveLength(0);
  });

  it("prioritizes a freshly GENERATED shift over a flexible-pool employee's stale static baseline — proving demand-driven generation actually takes effect, not silently bypassed", () => {
    // A Boarding/fixed_rule requirement's window is now T-1h from departure
    // (standard aircraft) — see requirement-window.ts — so drive it via
    // scheduled_departure. 21:00 departure -> 20:00-21:00 window, which is
    // OUTSIDE the employee's stale static baseline shift (MT01: 05:45-14:45)
    // entirely — only the freshly generated shift (AP02) covers it.
    const flight = makeFlight({ scheduled_departure: "21:00" });
    const requirement = makeRequirement({});
    // This employee's stale seed baseline (MT01: 05:45-14:45) does NOT
    // cover this window at all — only the freshly generated shift does.
    // If the fix didn't work, this employee would be excluded entirely.
    const employee = makeEmployee({
      id: "flex-1",
      shift_code: "AP01",
      shift_start: "13:45",
      shift_end: "22:45",
      weekly_shifts: [{ day_of_week: "Wednesday", shift_code: "MT01", status: "working" }],
    });
    const generatedShift = [
      { employeeId: "flex-1", dayOfWeek: "Wednesday", shiftCode: "AP02", coversRoles: ["Boarding"] }, // 13:45-23:15, covers the 20:00-21:00 window. Same-day (not overnight) — NT01/N8/AP03/AP04 are overnight and trip a separate, already-documented limitation (simple minute-diff math doesn't handle midnight-crossing shifts), which is not what this test is isolating.
    ];

    const { duties } = generateDutiesForDay("Wednesday", [requirement], [flight], [employee], generatedShift, [], CONFIG);
    expect(duties).toHaveLength(1);
    expect(duties[0].employeeId).toBe("flex-1");
  });
});
