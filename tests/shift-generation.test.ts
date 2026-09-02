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

  it("never assigns an employee who is OFF that day", () => {
    const flight = makeFlight({});
    const requirement = makeRequirement({ total_requirement: 1 });
    const demand = aggregateDailyDemand("Wednesday", [flight], [requirement]);

    const offEmployee = makeEmployee({
      id: "off-1",
      skills: ["Boarding"],
      weekly_shifts: [{ day_of_week: "Wednesday", shift_code: null, status: "off" }],
    });
    const result = generateFlexiblePoolShifts("Wednesday", demand, [offEmployee]);
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

  it("never fabricates a shift for a demand window no catalog code can cover", () => {
    const flight = makeFlight({ boarding_window_start: "02:00", boarding_window_end: "03:00" }); // impossible window
    const requirement = makeRequirement({ total_requirement: 1 });
    const demand = aggregateDailyDemand("Wednesday", [flight], [requirement]);
    const employee = makeEmployee({ id: "e1", skills: ["Boarding"] });

    const result = generateFlexiblePoolShifts("Wednesday", demand, [employee]);
    expect(result).toHaveLength(0);
  });
});
