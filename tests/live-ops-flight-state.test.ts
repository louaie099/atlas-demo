import { describe, it, expect } from "vitest";
import { deriveFlightState } from "../lib/live-ops-flight-state";
import { Flight, StaffingRequirement } from "../lib/types";
import { LiveOpsFlightView } from "../lib/live-ops-service";

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: "f1",
    flight_number: "AT535",
    airline: "Royal Air Maroc",
    route: "CMN-CDG",
    origin: "CMN",
    destination: "CDG",
    aircraft: "B737",
    equipment_code: null,
    registration: null,
    callsign: null,
    terminal: "T1",
    scheduled_departure: "14:00",
    actual_departure: null,
    scheduled_arrival: null,
    gate: null,
    boarding_window_start: null,
    boarding_window_end: null,
    status: "scheduled",
    booking_pressure: "normal",
    day_of_week: "Monday",
    flight_date: "2026-10-05",
    week_start: "2026-10-05",
    operator_type: "atlas_managed",
    destination_category: null,
    booked_passengers: null,
    seat_capacity: null,
    ...overrides,
  };
}

const requirement: StaffingRequirement = {
  id: "r1",
  flight_id: "f1",
  role: "Boarding",
  baseline_requirement: 2,
  additional_requirement: 0,
  total_requirement: 2,
  source: "fixed_rule",
  reasoning: "",
  needs_configuration: false,
};

function makeView(overrides: Partial<LiveOpsFlightView> = {}): LiveOpsFlightView {
  const flight = overrides.flight ?? makeFlight();
  return {
    flight,
    effectiveDeparture: flight.scheduled_departure,
    requirements: [],
    ...overrides,
  };
}

describe("deriveFlightState", () => {
  it("is covered when fully assigned, not delayed, no active conflict", () => {
    const view = makeView({
      requirements: [{ requirement, coverageLabel: "Boarding", coverageStatus: "assigned", gap: 0, assignedEmployees: [], proposedEmployees: [] }],
    });
    expect(deriveFlightState(view, false)).toBe("covered");
  });

  it("is gap when any requirement has coverageStatus gap", () => {
    const view = makeView({
      requirements: [{ requirement, coverageLabel: "Boarding", coverageStatus: "gap", gap: 1, assignedEmployees: [], proposedEmployees: [] }],
    });
    expect(deriveFlightState(view, false)).toBe("gap");
  });

  it("treats a requirement-level conflict status as gap priority", () => {
    const view = makeView({
      requirements: [{ requirement, coverageLabel: "Boarding", coverageStatus: "conflict", gap: 0, assignedEmployees: [], proposedEmployees: [] }],
    });
    expect(deriveFlightState(view, false)).toBe("gap");
  });

  it("is delayed when status is delayed and nothing else flags", () => {
    const flight = makeFlight({ status: "delayed" });
    const view = makeView({
      flight,
      requirements: [{ requirement, coverageLabel: "Boarding", coverageStatus: "assigned", gap: 0, assignedEmployees: [], proposedEmployees: [] }],
    });
    expect(deriveFlightState(view, false)).toBe("delayed");
  });

  it("is delayed when effectiveDeparture differs from scheduled, even if status is still scheduled", () => {
    const flight = makeFlight({ actual_departure: "15:00" });
    const view = makeView({
      flight,
      effectiveDeparture: "15:00",
      requirements: [{ requirement, coverageLabel: "Boarding", coverageStatus: "assigned", gap: 0, assignedEmployees: [], proposedEmployees: [] }],
    });
    expect(deriveFlightState(view, false)).toBe("delayed");
  });

  it("prioritizes conflict over gap and delayed", () => {
    const flight = makeFlight({ status: "delayed" });
    const view = makeView({
      flight,
      requirements: [{ requirement, coverageLabel: "Boarding", coverageStatus: "gap", gap: 1, assignedEmployees: [], proposedEmployees: [] }],
    });
    expect(deriveFlightState(view, true)).toBe("conflict");
  });

  it("prioritizes gap over delayed", () => {
    const flight = makeFlight({ status: "delayed" });
    const view = makeView({
      flight,
      requirements: [{ requirement, coverageLabel: "Boarding", coverageStatus: "gap", gap: 1, assignedEmployees: [], proposedEmployees: [] }],
    });
    expect(deriveFlightState(view, false)).toBe("gap");
  });
});
