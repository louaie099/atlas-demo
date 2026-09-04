import { describe, it, expect } from "vitest";
import { getRequirementWindow } from "../lib/planning/requirement-window";
import { Flight, StaffingRequirement } from "../lib/types";

function makeFlight(overrides: Partial<Flight>): Flight {
  return {
    id: "f1", flight_number: "AT100", airline: "Royal Air Maroc", route: "CMN → X",
    origin: "CMN", destination: "X", aircraft: "Boeing 737-800", equipment_code: null,
    registration: null, callsign: null, terminal: "T1", scheduled_departure: "14:00",
    scheduled_arrival: null, gate: null, boarding_window_start: null, boarding_window_end: null,
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

describe("getRequirementWindow — RAM operation-rule roles (Gate/Boarding/Profiling/Mesure)", () => {
  it("starts T-1h before departure for a standard (non-Dreamliner) aircraft", () => {
    const flight = makeFlight({ scheduled_departure: "14:00", aircraft: "Boeing 737-800" });
    const requirement = makeRequirement({ role: "Boarding" });
    expect(getRequirementWindow(requirement, flight)).toEqual({ start: "13:00", end: "14:00" });
  });

  it("starts T-1h30 before departure for a Dreamliner", () => {
    const flight = makeFlight({ scheduled_departure: "14:00", aircraft: "Boeing 787-9" });
    const requirement = makeRequirement({ role: "Boarding" });
    expect(getRequirementWindow(requirement, flight)).toEqual({ start: "12:30", end: "14:00" });
  });

  it("Gate, Boarding, and Profiling share the exact same window for the same flight — genuinely concurrent, never staggered", () => {
    const flight = makeFlight({ scheduled_departure: "14:00", aircraft: "Boeing 737-800" });
    const gate = getRequirementWindow(makeRequirement({ role: "Gate" }), flight);
    const boarding = getRequirementWindow(makeRequirement({ role: "Boarding" }), flight);
    const profiling = getRequirementWindow(makeRequirement({ role: "Profiling" }), flight);
    expect(gate).toEqual(boarding);
    expect(boarding).toEqual(profiling);
  });

  it("runs until scheduled/updated departure, not an earlier cutoff — an updated departure shifts the window with it", () => {
    const delayedFlight = makeFlight({ scheduled_departure: "15:30", aircraft: "Boeing 737-800" });
    const requirement = makeRequirement({ role: "Boarding" });
    expect(getRequirementWindow(requirement, delayedFlight)).toEqual({ start: "14:30", end: "15:30" });
  });

  it("ignores an explicit boarding_window_start/end on the flight for these roles — the aircraft-class rule is authoritative now", () => {
    const flight = makeFlight({
      scheduled_departure: "14:00",
      aircraft: "Boeing 737-800",
      boarding_window_start: "20:00",
      boarding_window_end: "20:30",
    });
    const requirement = makeRequirement({ role: "Boarding" });
    expect(getRequirementWindow(requirement, flight)).toEqual({ start: "13:00", end: "14:00" });
  });
});

describe("getRequirementWindow — everything else (Check-in, foreign-company) keeps the previous approximation", () => {
  it("still uses the flight's real boarding window when set, for a non-RAM-operation-rule requirement", () => {
    const flight = makeFlight({ boarding_window_start: "08:50", boarding_window_end: "09:20" });
    const requirement = makeRequirement({ role: "Check-in", source: "demand_forecast" });
    expect(getRequirementWindow(requirement, flight)).toEqual({ start: "08:50", end: "09:20" });
  });

  it("falls back to 45-15 minutes before departure when no explicit boarding window exists", () => {
    const flight = makeFlight({ scheduled_departure: "09:00", boarding_window_start: null, boarding_window_end: null });
    const requirement = makeRequirement({ role: "Check-in", source: "demand_forecast" });
    expect(getRequirementWindow(requirement, flight)).toEqual({ start: "08:15", end: "08:45" });
  });

  it("a company_config (foreign-carrier) requirement also keeps the previous fallback, not the RAM aircraft-class rule", () => {
    const flight = makeFlight({ scheduled_departure: "09:00", boarding_window_start: null, boarding_window_end: null, aircraft: "Boeing 787-9" });
    const requirement = makeRequirement({ role: "Ramp Team", source: "company_config" });
    expect(getRequirementWindow(requirement, flight)).toEqual({ start: "08:15", end: "08:45" });
  });
});
