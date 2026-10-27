import { describe, it, expect } from "vitest";
import { generateDutiesForDay } from "../lib/planning/duty-generation";
import { GeneratedShiftAssignment } from "../lib/planning/shift-generation";
import { CONFIG } from "../lib/seed-data";
import { Employee, Flight, StaffingRequirement } from "../lib/types";

/**
 * Regression coverage for the 2026-10-27 fix: a brand-new employee (just
 * created via the single-employee form, or bulk-imported -- see
 * lib/employee-import.ts's own doc comment) always starts with
 * Employee.weekly_hours === null, by explicit design ("planning state ...
 * is never accepted here ... belongs to Weekly Planning/roster
 * generation"). But scoring.ts's hasRosterAssigned hard-excludes ANY
 * candidate whose weekly_hours is strictly null from duty scoring
 * entirely -- not flagged, not even considered -- and nothing in
 * generation ever wrote a real value back onto that field for a
 * generation-driven employee (shift_start/shift_end/rest_before_shift_hours
 * were already substituted in duty-generation.ts's dayEffectivePool; only
 * weekly_hours was missed). The result, confirmed live: a real, newly
 * bulk-imported, correctly-authorized, correctly-on-shift employee was
 * PERMANENTLY unable to ever be assigned to any duty -- including their
 * own authorized foreign-company requirement -- with no error, and no way
 * for it to ever self-correct (weekly_hours is never written anywhere
 * else either).
 */
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "emp", name: "Test", skills: ["Boarding"], assignment: "General T1 Pool",
    shift_code: null, shift_start: null, shift_end: null, rest_before_shift_hours: 24,
    weekly_hours: null, is_duty_officer: false, off_days: [], foreign_company_authorizations: [],
    active: true, weekly_shifts: [],
    ...overrides,
  };
}

function makeQatarRequirement(overrides: Partial<StaffingRequirement>): StaffingRequirement {
  return {
    id: "req-qr-wed-company-team", flight_id: "qr-wed", role: "Company Team",
    baseline_requirement: 1, additional_requirement: 0, total_requirement: 1,
    source: "company_config", reasoning: "test", needs_configuration: false,
    ...overrides,
  };
}

function makeQatarFlight(overrides: Partial<Flight>): Flight {
  return {
    id: "qr-wed", flight_number: "QR105", airline: "Qatar Airways", route: "CMN → DOH",
    origin: "CMN", destination: "DOH", aircraft: "Airbus A320", equipment_code: null,
    registration: null, callsign: null, terminal: "T1", scheduled_departure: "18:30",
    scheduled_arrival: null, gate: null, boarding_window_start: null, boarding_window_end: null,
    status: "scheduled", booking_pressure: "normal", day_of_week: "Wednesday", flight_date: "2026-09-24",
    week_start: "2026-09-21", operator_type: "self_managed", destination_category: null,
    booked_passengers: null, seat_capacity: null,
    ...overrides,
  };
}

describe("a brand-new employee (weekly_hours === null) is still eligible for duty assignment", () => {
  it("is actually deployed to their own authorized foreign-company duty, not silently excluded", () => {
    // A brand-new Qatar Airways employee: real authorization, real
    // generated working shift covering the flight window, but
    // weekly_hours still null -- exactly the shape of a freshly
    // bulk-imported or newly created employee before this fix.
    const newEmployee = makeEmployee({
      id: "new-employee", assignment: "Qatar Airways", foreign_company_authorizations: ["Qatar Airways"],
    });
    const flights = [makeQatarFlight({})];
    const requirements = [makeQatarRequirement({})];
    const generatedShifts: GeneratedShiftAssignment[] = [
      { employeeId: "new-employee", dayOfWeek: "Wednesday", shiftCode: "AP01", coversRoles: ["Company Team"] },
    ];

    const { duties, unfilled } = generateDutiesForDay(
      "Wednesday", requirements, flights, [newEmployee], generatedShifts, [], CONFIG, "2026-09-24"
    );

    expect(unfilled).toEqual([]);
    expect(duties).toHaveLength(1);
    expect(duties[0].employeeId).toBe("new-employee");
  });

  it("an employee with a real static weekly_hours baseline is completely unaffected (no behavior change)", () => {
    const establishedEmployee = makeEmployee({
      id: "established-employee", assignment: "Qatar Airways", foreign_company_authorizations: ["Qatar Airways"],
      weekly_hours: 24,
    });
    const flights = [makeQatarFlight({})];
    const requirements = [makeQatarRequirement({})];
    const generatedShifts: GeneratedShiftAssignment[] = [
      { employeeId: "established-employee", dayOfWeek: "Wednesday", shiftCode: "AP01", coversRoles: ["Company Team"] },
    ];

    const { duties, unfilled } = generateDutiesForDay(
      "Wednesday", requirements, flights, [establishedEmployee], generatedShifts, [], CONFIG, "2026-09-24"
    );

    expect(unfilled).toEqual([]);
    expect(duties).toHaveLength(1);
    expect(duties[0].employeeId).toBe("established-employee");
  });
});
