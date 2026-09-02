import { describe, it, expect } from "vitest";
import { buildWeeklyPlanView, computeCoverageStatus } from "../lib/planning/weekly-plan-view";
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
    id: "req-f1-boarding", flight_id: "f1", role: "Boarding", baseline_requirement: 1, additional_requirement: 0,
    total_requirement: 1, source: "fixed_rule", reasoning: "", needs_configuration: false,
    ...overrides,
  };
}

const DAYS = ["Wednesday"];

describe("computeCoverageStatus", () => {
  it("is needs_configuration whenever the requirement says so, regardless of counts", () => {
    const req = makeRequirement({ needs_configuration: true, total_requirement: 0 });
    expect(computeCoverageStatus(req, 5, 5)).toBe("needs_configuration");
  });

  it("is covered only when CONFIRMED alone meets the requirement", () => {
    const req = makeRequirement({ total_requirement: 2 });
    expect(computeCoverageStatus(req, 2, 0)).toBe("covered");
  });

  it("is proposed — not covered — when confirmed alone falls short but confirmed+proposed meets it", () => {
    const req = makeRequirement({ total_requirement: 2 });
    expect(computeCoverageStatus(req, 1, 1)).toBe("proposed");
  });

  it("is gap when even confirmed+proposed falls short", () => {
    const req = makeRequirement({ total_requirement: 3 });
    expect(computeCoverageStatus(req, 1, 1)).toBe("gap");
  });
});

describe("buildWeeklyPlanView", () => {
  it("derives roster and schedule from the exact same generated draft plan — a proposed duty appears consistently in both", () => {
    const flight = makeFlight({});
    const requirement = makeRequirement({ total_requirement: 1 });
    const employee = makeEmployee({ id: "e1", name: "Amina Test" });

    const { roster, schedule } = buildWeeklyPlanView([flight], [employee], [], [requirement], CONFIG, DAYS, "Test Week");

    // Flight Coverage: the requirement is met only via the engine's proposal.
    expect(roster).toHaveLength(1);
    expect(roster[0].coverageStatus).toBe("proposed");
    expect(roster[0].proposedEmployees.map((e) => e.id)).toEqual(["e1"]);

    // Agent Schedule: the SAME employee shows the SAME proposed duty — not
    // a second, independently-computed view that could disagree.
    const entry = schedule.find((s) => s.employee.id === "e1")!;
    expect(entry.duties).toHaveLength(0);
    expect(entry.proposedDuties).toEqual([{ flightNumber: "AT100", role: "Boarding", dayOfWeek: "Wednesday" }]);
  });

  it("once a proposal is confirmed via a real Assignment row, both views drop it from 'proposed' and roster shows covered", () => {
    const flight = makeFlight({});
    const requirement = makeRequirement({ total_requirement: 1 });
    const employee = makeEmployee({ id: "e1", name: "Amina Test" });
    const assignment: Assignment = { id: "a1", staffing_requirement_id: "req-f1-boarding", employee_id: "e1", assigned_at: "" };

    const { roster, schedule } = buildWeeklyPlanView([flight], [employee], [assignment], [requirement], CONFIG, DAYS, "Test Week");

    expect(roster[0].coverageStatus).toBe("covered");
    expect(roster[0].proposedEmployees).toHaveLength(0);
    expect(roster[0].assignedEmployees.map((e) => e.id)).toEqual(["e1"]);

    const entry = schedule.find((s) => s.employee.id === "e1")!;
    expect(entry.duties).toEqual([{ flightNumber: "AT100", role: "Boarding", dayOfWeek: "Wednesday" }]);
    expect(entry.proposedDuties).toHaveLength(0);
  });

  it("a requirement with no qualified rostered employee is a real, visible gap in the roster view — never fabricated", () => {
    const flight = makeFlight({});
    const requirement = makeRequirement({ total_requirement: 1 });
    const unqualified = makeEmployee({ id: "e1", skills: ["Gate"] });

    const { roster, schedule } = buildWeeklyPlanView([flight], [unqualified], [], [requirement], CONFIG, DAYS, "Test Week");

    expect(roster[0].coverageStatus).toBe("gap");
    expect(roster[0].gap).toBe(1);
    const entry = schedule.find((s) => s.employee.id === "e1")!;
    expect(entry.duties).toHaveLength(0);
    expect(entry.proposedDuties).toHaveLength(0);
  });
});
