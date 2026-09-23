import { describe, it, expect } from "vitest";
import { generateDutiesForDay } from "../lib/planning/duty-generation";
import { CONFIG } from "../lib/seed-data";
import { Employee, Flight, StaffingRequirement } from "../lib/types";

const TEST_DATE = "2026-09-24";

/**
 * Regression coverage for Fix 3 (2026-09-22 audit -- see
 * docs/known-limitations/roster-planning-vs-duty-allocation.md): the
 * exact double-booking scenario from the audit (a Boarding duty inside a
 * real foreign-company protected window) is now rejected.
 */

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "emp", name: "Test", skills: ["Boarding"], assignment: "General T1 Pool",
    shift_code: null, shift_start: null, shift_end: null, rest_before_shift_hours: null,
    weekly_hours: null, is_duty_officer: false, off_days: [], foreign_company_authorizations: [],
    active: true, weekly_shifts: [],
    ...overrides,
  };
}

function makeFlight(overrides: Partial<Flight>): Flight {
  return {
    id: "f1", flight_number: "GF105", airline: "Gulf Air", route: "CMN → BAH",
    origin: "CMN", destination: "BAH", aircraft: "Airbus A320", equipment_code: null,
    registration: null, callsign: null, terminal: "T1", scheduled_departure: "09:00",
    scheduled_arrival: "18:00", gate: null, boarding_window_start: null, boarding_window_end: null,
    status: "scheduled", booking_pressure: "normal", day_of_week: "Wednesday", flight_date: "2026-09-24",
    week_start: "2026-09-21", operator_type: "self_managed", destination_category: null,
    booked_passengers: null, seat_capacity: null,
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

describe("Fix 3 -- the audited double-booking scenario (Boarding duty inside a real company protected window) is rejected", () => {
  it("an employee is never assigned both a RAM Boarding duty and a foreign-company duty whose real protected window swallows it", () => {
    // Reproduces the audit's exact scenario shape: a RAM flight departing
    // shortly before a foreign-company flight whose real protected window
    // (~4h30 before departure) swallows the RAM flight's operational
    // window entirely -- an AT100-shaped Boarding duty at 06:15-07:15 vs
    // a GF105-shaped company flight's protected window 04:30-09:00 (09:00
    // departure).
    const employee = makeEmployee({
      id: "e1", assignment: "General T1 Pool", skills: ["Boarding"],
      foreign_company_authorizations: ["Gulf Air"],
    });

    const ramFlight = makeFlight({
      id: "ram-1", airline: "Royal Air Maroc", operator_type: "atlas_managed",
      scheduled_departure: "07:15", day_of_week: "Wednesday",
    });
    const ramReq = makeRequirement({
      id: "r-ram", flight_id: "ram-1", role: "Boarding", source: "fixed_rule", total_requirement: 1,
    });

    const gfFlight = makeFlight({
      id: "gf-1", airline: "Gulf Air", operator_type: "self_managed",
      scheduled_departure: "09:00", day_of_week: "Wednesday",
    });
    const gfReq = makeRequirement({
      id: "r-gf", flight_id: "gf-1", role: "Company Team", source: "company_config", total_requirement: 1,
    });

    // MT02 (04:30-14:45) fully covers both AT100 Boarding's 06:15-07:15
    // window and GF105's 04:30-09:00 protected window.
    const generatedShifts = [{ employeeId: "e1", dayOfWeek: "Wednesday", shiftCode: "MT02", coversRoles: [] }];

    const { duties } = generateDutiesForDay(
      "Wednesday",
      [ramReq, gfReq],
      [ramFlight, gfFlight],
      [employee],
      generatedShifts,
      [],
      CONFIG,
      TEST_DATE
    );

    const employeeDuties = duties.filter((d) => d.employeeId === "e1");
    expect(employeeDuties.length).toBeLessThanOrEqual(1); // never both -- no double-booking
  });
});
