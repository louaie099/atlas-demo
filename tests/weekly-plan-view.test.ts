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
    booked_passengers: null, seat_capacity: null,
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
  // needs_configuration requirements never reach computeCoverageStatus in
  // practice — buildRosterViews filters them out first (see below) — but
  // the function itself no longer special-cases the flag at all; a
  // needs_configuration requirement typically also carries
  // total_requirement 0, which is trivially "assigned" (0 >= 0). This is
  // harmless precisely because such requirements are filtered out upstream.

  it("is assigned when CONFIRMED alone meets the requirement", () => {
    const req = makeRequirement({ total_requirement: 2 });
    expect(computeCoverageStatus(req, 2, 0)).toBe("assigned");
  });

  it("is assigned — a normal draft-plan assignment, not a pending recommendation — when confirmed alone falls short but confirmed+ATLAS-assigned meets it", () => {
    const req = makeRequirement({ total_requirement: 2 });
    expect(computeCoverageStatus(req, 1, 1)).toBe("assigned");
  });

  it("is gap when even confirmed+ATLAS-assigned falls short", () => {
    const req = makeRequirement({ total_requirement: 3 });
    expect(computeCoverageStatus(req, 1, 1)).toBe("gap");
  });
});

describe("buildWeeklyPlanView", () => {
  it("derives roster and schedule from the exact same generated draft plan — an ATLAS-assigned duty appears consistently in both", () => {
    const flight = makeFlight({});
    const requirement = makeRequirement({ total_requirement: 1 });
    const employee = makeEmployee({ id: "e1", name: "Amina Test" });

    const { roster, schedule } = buildWeeklyPlanView([flight], [employee], [], [requirement], CONFIG, DAYS, "Test Week");

    // Flight Coverage: the requirement is met only via the engine's own
    // draft-plan assignment — still "assigned", not a pending recommendation.
    expect(roster).toHaveLength(1);
    expect(roster[0].coverageStatus).toBe("assigned");
    expect(roster[0].proposedEmployees.map((e) => e.id)).toEqual(["e1"]);

    // Agent Schedule: the SAME employee shows the SAME assigned duty — not
    // a second, independently-computed view that could disagree.
    const entry = schedule.find((s) => s.employee.id === "e1")!;
    expect(entry.duties).toHaveLength(0);
    expect(entry.proposedDuties).toEqual([{ flightNumber: "AT100", role: "Boarding", dayOfWeek: "Wednesday" }]);
  });

  it("once a duty is confirmed via a real Assignment row, both views drop it from proposedDuties/proposedEmployees, but coverage stays 'assigned' either way", () => {
    const flight = makeFlight({});
    const requirement = makeRequirement({ total_requirement: 1 });
    const employee = makeEmployee({ id: "e1", name: "Amina Test" });
    const assignment: Assignment = { id: "a1", staffing_requirement_id: "req-f1-boarding", employee_id: "e1", assigned_at: "" };

    const { roster, schedule } = buildWeeklyPlanView([flight], [employee], [assignment], [requirement], CONFIG, DAYS, "Test Week");

    expect(roster[0].coverageStatus).toBe("assigned");
    expect(roster[0].proposedEmployees).toHaveLength(0);
    expect(roster[0].assignedEmployees.map((e) => e.id)).toEqual(["e1"]);

    const entry = schedule.find((s) => s.employee.id === "e1")!;
    expect(entry.duties).toEqual([{ flightNumber: "AT100", role: "Boarding", dayOfWeek: "Wednesday" }]);
    expect(entry.proposedDuties).toHaveLength(0);
  });

  it("a needs_configuration requirement never becomes a Flight Coverage row at all — no routine 'Needs Configuration' state", () => {
    const flight = makeFlight({});
    const requirement = makeRequirement({ needs_configuration: true, total_requirement: 0 });
    const employee = makeEmployee({ id: "e1" });

    const { roster } = buildWeeklyPlanView([flight], [employee], [], [requirement], CONFIG, DAYS, "Test Week");

    expect(roster).toHaveLength(0);
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

  it("a company_config (foreign-carrier) requirement's coverageLabel is '{Airline} Team', regardless of the neutral internal role identifier", () => {
    const flight = makeFlight({ airline: "Gulf Air", operator_type: "self_managed" });
    const requirement = makeRequirement({
      role: "Company Team",
      source: "company_config",
      total_requirement: 1,
    });
    const employee = makeEmployee({ id: "e1", foreign_company_authorizations: ["Gulf Air"] });

    const { roster } = buildWeeklyPlanView([flight], [employee], [], [requirement], CONFIG, DAYS, "Test Week");

    expect(roster[0].coverageLabel).toBe("Gulf Air Team");
    expect(roster[0].requirement.role).toBe("Company Team"); // a label only -- carries no scoring weight
  });
});
