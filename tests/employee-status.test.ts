import { describe, it, expect } from "vitest";
import { computeEmployeeDaySummary } from "../lib/employee-status";
import { Employee, Assignment, StaffingRequirement, Flight } from "../lib/types";

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "emp-1",
    name: "Test Employee",
    skills: ["Boarding"],
    assignment: "General T1 Pool",
    shift_code: "MT01",
    shift_start: "05:45",
    shift_end: "14:45",
    rest_before_shift_hours: 11,
    weekly_hours: 20,
    is_duty_officer: false,
    off_days: [],
    foreign_company_authorizations: [],
    active: true,
    weekly_shifts: [{ day_of_week: "Wednesday", shift_code: "MT01", status: "working" }],
    ...overrides,
  };
}

const ramFlight: Flight = {
  id: "at201",
  flight_number: "AT201",
  airline: "Royal Air Maroc",
  route: "CMN → CDG",
  origin: "CMN",
  destination: "CDG",
  aircraft: "Boeing 737-800",
  equipment_code: null,
  registration: null,
  callsign: null,
  terminal: "T1",
  scheduled_departure: "14:30",
  scheduled_arrival: null,
  gate: "B12",
  boarding_window_start: "13:50",
  boarding_window_end: "14:20",
  status: "scheduled",
  booking_pressure: "normal",
  day_of_week: "Wednesday",
  operator_type: "atlas_managed",
  destination_category: "Europe/Schengen",
};

const foreignFlight: Flight = {
  ...ramFlight,
  id: "ek751",
  flight_number: "EK751",
  airline: "Emirates",
  operator_type: "self_managed",
  destination_category: null,
  scheduled_departure: "15:50",
};

const ramRequirement: StaffingRequirement = {
  id: "req-at201",
  flight_id: "at201",
  role: "Boarding",
  baseline_requirement: 3,
  additional_requirement: 0,
  total_requirement: 3,
  source: "fixed_rule",
  reasoning: "",
  needs_configuration: false,
};

const foreignRequirement: StaffingRequirement = {
  id: "req-ek751",
  flight_id: "ek751",
  role: "Ramp Team",
  baseline_requirement: 3,
  additional_requirement: 0,
  total_requirement: 3,
  source: "company_config",
  reasoning: "",
  needs_configuration: false,
};

describe("computeEmployeeDaySummary", () => {
  it("returns off status with no shift code when the day is OFF", () => {
    const employee = makeEmployee({
      weekly_shifts: [{ day_of_week: "Wednesday", shift_code: null, status: "off" }],
    });
    const summary = computeEmployeeDaySummary(employee, "Wednesday", [], [], []);
    expect(summary.status).toBe("off");
    expect(summary.shiftCode).toBeNull();
  });

  it("returns not_rostered (distinct from off) when no weekly_shifts entry exists for the day at all — e.g. a freshly-created employee", () => {
    const employee = makeEmployee({ weekly_shifts: [] });
    const summary = computeEmployeeDaySummary(employee, "Wednesday", [], [], []);
    expect(summary.status).toBe("not_rostered");
    expect(summary.shiftCode).toBeNull();
  });

  it("returns on_duty with the RAM flight listed as a duty for a normal working day with a RAM assignment", () => {
    const employee = makeEmployee({ id: "sara" });
    const assignments: Assignment[] = [
      { id: "a1", staffing_requirement_id: "req-at201", employee_id: "sara", assigned_at: "" },
    ];
    const summary = computeEmployeeDaySummary(employee, "Wednesday", assignments, [ramRequirement], [ramFlight]);
    expect(summary.status).toBe("on_duty");
    expect(summary.duties).toHaveLength(1);
    expect(summary.duties[0].flightNumber).toBe("AT201");
    expect(summary.foreignCommitment).toBeNull();
  });

  it("returns committed status with the correct protected window for a foreign-company assignment", () => {
    const employee = makeEmployee({ id: "ayoub", assignment: "Emirates" });
    const assignments: Assignment[] = [
      { id: "a1", staffing_requirement_id: "req-ek751", employee_id: "ayoub", assigned_at: "" },
    ];
    const summary = computeEmployeeDaySummary(employee, "Wednesday", assignments, [foreignRequirement], [foreignFlight]);
    expect(summary.status).toBe("committed");
    expect(summary.foreignCommitment).toEqual({ airline: "Emirates", window: { start: "11:20", end: "15:50" } });
  });

  it("returns transit status for a Transit-assigned employee with no foreign commitment that day", () => {
    const employee = makeEmployee({ id: "transit-1", assignment: "Transit" });
    const summary = computeEmployeeDaySummary(employee, "Wednesday", [], [], []);
    expect(summary.status).toBe("transit");
  });

  it("ignores assignments belonging to a different day", () => {
    const employee = makeEmployee({ id: "sara" });
    const mondayFlight: Flight = { ...ramFlight, day_of_week: "Monday" };
    const assignments: Assignment[] = [
      { id: "a1", staffing_requirement_id: "req-at201", employee_id: "sara", assigned_at: "" },
    ];
    const summary = computeEmployeeDaySummary(employee, "Wednesday", assignments, [ramRequirement], [mondayFlight]);
    expect(summary.duties).toHaveLength(0);
    expect(summary.status).toBe("on_duty");
  });
});
