import { describe, it, expect } from "vitest";
import { getEmployeeForeignCommitments } from "../lib/foreign-company-window";
import { Assignment, StaffingRequirement, Flight } from "../lib/types";

const foreignFlight: Flight = {
  id: "qr1013",
  flight_number: "QR1013",
  airline: "Qatar Airways",
  route: "CMN → DOH",
  origin: "CMN",
  destination: "DOH",
  aircraft: "Airbus A350",
  equipment_code: null,
  registration: null,
  callsign: null,
  terminal: "T2",
  scheduled_departure: "16:45",
  scheduled_arrival: null,
  gate: null,
  boarding_window_start: null,
  boarding_window_end: null,
  status: "scheduled",
  booking_pressure: "normal",
  day_of_week: "Wednesday",
  operator_type: "self_managed",
  destination_category: null,
};

const ramFlight: Flight = {
  ...foreignFlight,
  id: "at201",
  flight_number: "AT201",
  airline: "Royal Air Maroc",
  operator_type: "atlas_managed",
  destination_category: "Europe/Schengen",
};

const foreignRequirement: StaffingRequirement = {
  id: "req-qr1013",
  flight_id: "qr1013",
  role: "Ramp Team",
  baseline_requirement: 2,
  additional_requirement: 0,
  total_requirement: 2,
  source: "company_config",
  reasoning: "test",
  needs_configuration: false,
};

const ramRequirement: StaffingRequirement = {
  id: "req-at201",
  flight_id: "at201",
  role: "Boarding",
  baseline_requirement: 3,
  additional_requirement: 0,
  total_requirement: 3,
  source: "fixed_rule",
  reasoning: "test",
  needs_configuration: false,
};

describe("getEmployeeForeignCommitments", () => {
  it("returns a commitment, with the correct window, for an employee assigned to a self-managed flight's requirement", () => {
    const assignments: Assignment[] = [
      { id: "a1", staffing_requirement_id: "req-qr1013", employee_id: "emp-1", assigned_at: "" },
    ];
    const commitments = getEmployeeForeignCommitments(
      "emp-1",
      assignments,
      [foreignRequirement],
      [foreignFlight]
    );
    expect(commitments).toHaveLength(1);
    expect(commitments[0].airline).toBe("Qatar Airways");
    expect(commitments[0].window).toEqual({ start: "12:15", end: "16:45" });
  });

  it("returns no commitment for an employee only assigned to RAM (fixed_rule) requirements — capacity is not consumed outside a foreign window", () => {
    const assignments: Assignment[] = [
      { id: "a1", staffing_requirement_id: "req-at201", employee_id: "emp-1", assigned_at: "" },
    ];
    const commitments = getEmployeeForeignCommitments(
      "emp-1",
      assignments,
      [ramRequirement],
      [ramFlight]
    );
    expect(commitments).toHaveLength(0);
  });

  it("returns no commitments for an employee with no assignments at all", () => {
    const commitments = getEmployeeForeignCommitments("emp-unassigned", [], [foreignRequirement], [foreignFlight]);
    expect(commitments).toHaveLength(0);
  });
});
