import { describe, it, expect } from "vitest";
import { generateFlexiblePoolShifts } from "../lib/planning/shift-generation";
import { aggregateDailyDemand } from "../lib/planning/demand-aggregation";
import { Employee, Flight, StaffingRequirement } from "../lib/types";

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "emp", name: "Test", skills: ["Boarding"], assignment: "General T1 Pool",
    shift_code: null, shift_start: null, shift_end: null, rest_before_shift_hours: null,
    weekly_hours: null, is_duty_officer: false, off_days: [], foreign_company_authorizations: [],
    active: true, weekly_shifts: [{ day_of_week: "Wednesday", shift_code: null, status: "working" }],
    ...overrides,
  };
}

function makeFlight(overrides: Partial<Flight>): Flight {
  return {
    id: "f1", flight_number: "AT100", airline: "Royal Air Maroc", route: "CMN → X",
    origin: "CMN", destination: "X", aircraft: "Boeing 737-800", equipment_code: null,
    registration: null, callsign: null, terminal: "T1", scheduled_departure: "10:00",
    scheduled_arrival: null, gate: null, boarding_window_start: "09:00", boarding_window_end: "10:00",
    status: "scheduled", booking_pressure: "normal", day_of_week: "Wednesday",
    operator_type: "atlas_managed", destination_category: "Europe/Schengen",
    booked_passengers: null, seat_capacity: null,
    ...overrides,
  };
}

function makeRequirement(overrides: Partial<StaffingRequirement>): StaffingRequirement {
  return {
    id: "r1", flight_id: "f1", role: "Boarding", baseline_requirement: 2, additional_requirement: 0,
    total_requirement: 2, source: "fixed_rule", reasoning: "", needs_configuration: false,
    ...overrides,
  };
}

describe("generateFlexiblePoolShifts", () => {
  it("assigns exactly enough qualified employees to meet peak demand", () => {
    const flight = makeFlight({});
    const requirement = makeRequirement({ total_requirement: 2 });
    const demand = aggregateDailyDemand("Wednesday", [flight], [requirement]);

    const employees = [
      makeEmployee({ id: "e1", skills: ["Boarding"] }),
      makeEmployee({ id: "e2", skills: ["Boarding"] }),
      makeEmployee({ id: "e3", skills: ["Boarding"] }), // extra, shouldn't be needed
    ];

    const result = generateFlexiblePoolShifts("Wednesday", demand, employees);
    expect(result).toHaveLength(2);
  });

  it("DEMAND-DRIVEN, not template-driven: assigns an employee even when their static weekly_shifts baseline marks them OFF that day — that baseline is durable fallback/legacy data now, never authoritative for whether a flexible employee is available (see duty-generation.ts's effectiveShiftForDay)", () => {
    const flight = makeFlight({});
    const requirement = makeRequirement({ total_requirement: 1 });
    const demand = aggregateDailyDemand("Wednesday", [flight], [requirement]);

    const staticallyOffEmployee = makeEmployee({
      id: "e1",
      skills: ["Boarding"],
      weekly_shifts: [{ day_of_week: "Wednesday", shift_code: null, status: "off" }],
    });
    const result = generateFlexiblePoolShifts("Wednesday", demand, [staticallyOffEmployee]);
    expect(result).toHaveLength(1);
    expect(result[0].employeeId).toBe("e1");
  });

  it("never assigns an INACTIVE employee, regardless of demand — active is a real hard exclusion, unlike the static weekly_shifts template", () => {
    const flight = makeFlight({});
    const requirement = makeRequirement({ total_requirement: 1 });
    const demand = aggregateDailyDemand("Wednesday", [flight], [requirement]);

    const inactiveEmployee = makeEmployee({ id: "inactive-1", skills: ["Boarding"], active: false });
    const result = generateFlexiblePoolShifts("Wednesday", demand, [inactiveEmployee]);
    expect(result).toHaveLength(0);
  });

  it("never assigns a non-flexible-pool employee (e.g. Transit-assigned) even if skilled", () => {
    const flight = makeFlight({});
    const requirement = makeRequirement({ total_requirement: 1 });
    const demand = aggregateDailyDemand("Wednesday", [flight], [requirement]);

    const transitEmployee = makeEmployee({ id: "t1", skills: ["Boarding"], assignment: "Transit" });
    const result = generateFlexiblePoolShifts("Wednesday", demand, [transitEmployee]);
    expect(result).toHaveLength(0);
  });

  it("reuses one multi-skilled employee's shift to cover a second role, rather than rostering someone new", () => {
    const boardingFlight = makeFlight({ id: "b", boarding_window_start: "09:00", boarding_window_end: "10:00" });
    const boardingReq = makeRequirement({ id: "rb", flight_id: "b", role: "Boarding", total_requirement: 1 });
    const gateFlight = makeFlight({ id: "g", boarding_window_start: "09:00", boarding_window_end: "10:00" });
    const gateReq = makeRequirement({ id: "rg", flight_id: "g", role: "Gate", total_requirement: 1 });

    const demand = aggregateDailyDemand("Wednesday", [boardingFlight, gateFlight], [boardingReq, gateReq]);

    // Only ONE employee exists, qualified for both roles.
    const multiSkilled = makeEmployee({ id: "multi-1", skills: ["Boarding", "Gate"] });
    const result = generateFlexiblePoolShifts("Wednesday", demand, [multiSkilled]);

    expect(result).toHaveLength(1); // one shift, not two separate assignments
    expect(result[0].coversRoles).toContain("Boarding");
    expect(result[0].coversRoles).toContain("Gate");
  });

  it("RANKED SHIFT-CODE FALLBACK: tries every compatible candidate code before giving up, but the rest gate applies identically to every candidate — a rest-blocked employee is never rescued by trying a worse-fit code (a later-ranked candidate never starts LATER than the top choice, so backward rest can only be equal or worse)", () => {
    // Window 05:45-14:45 matches MT01 exactly (top-ranked); MT03 and JR01
    // are also compatible (same entree, longer duration) — real fallback
    // candidates, not fabricated ones.
    const flight = makeFlight({ scheduled_departure: "14:45", boarding_window_start: "05:45", boarding_window_end: "14:45" });
    const requirement = makeRequirement({ total_requirement: 1 });
    const demand = aggregateDailyDemand("Wednesday", [flight], [requirement]);

    const employee = makeEmployee({ id: "e1", skills: ["Boarding"] });
    // Ended a shift at 23:00 the day before -- only 6h45 before 05:45,
    // hard-blocked no matter which compatible code (all share the same
    // 05:45 entree) is tried.
    const priorDayShift = new Map([["e1", { shift_start: "13:45", shift_end: "23:00" }]]);

    const result = generateFlexiblePoolShifts("Wednesday", demand, [employee], priorDayShift, 15);
    expect(result).toHaveLength(0); // genuine shortfall, never a rest-violating assignment from a fallback candidate
  });

  it("never fabricates a shift for a demand window no catalog code can cover", () => {
    // T-1h from a 03:00 departure = 02:00-03:00 — before every shift's
    // earliest start (04:30), so no catalog code can cover it.
    const flight = makeFlight({ scheduled_departure: "03:00" });
    const requirement = makeRequirement({ total_requirement: 1 });
    const demand = aggregateDailyDemand("Wednesday", [flight], [requirement]);
    const employee = makeEmployee({ id: "e1", skills: ["Boarding"] });

    const result = generateFlexiblePoolShifts("Wednesday", demand, [employee]);
    expect(result).toHaveLength(0);
  });

  it("REGRESSION (deployed bug): a Check-in demand cluster opening before every catalog code's entree is still covered by a real, later-starting code, instead of leaving a qualified/idle employee unrostered", () => {
    // AT100-style 07:15 departure: Check-in opens T-180 (04:15) and
    // closes T-45 (06:30) under DEFAULT_CHECKIN_DEMAND_POLICY. No catalog
    // code starts at or before 04:15 (earliest entree is 04:30), so the
    // OLD full-containment-only matching left this cluster with zero
    // candidate codes and rostered nobody -- even though the employee
    // below is qualified, active, and has no conflicting prior shift.
    const flight = makeFlight({ id: "at100-monday", flight_number: "AT100", scheduled_departure: "07:15" });
    const requirement = makeRequirement({ id: "req-checkin", flight_id: "at100-monday", role: "Check-in", source: "demand_forecast", total_requirement: 1 });
    const demand = aggregateDailyDemand("Wednesday", [flight], [requirement]);
    const employee = makeEmployee({ id: "e1", skills: ["Check-in"] });

    const result = generateFlexiblePoolShifts("Wednesday", demand, [employee]);
    expect(result).toHaveLength(1);
    expect(result[0].employeeId).toBe("e1");
    // MT02 (04:30-14:45) is the closest-fit code that still runs through
    // the window's 06:30 close -- exactly what scoring.ts's own
    // duty-assignment stage already treats as valid coverage.
    expect(result[0].shiftCode).toBe("MT02");
  });
});
