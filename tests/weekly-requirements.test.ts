import { describe, it, expect } from "vitest";
import { classifyFlightRequirements, computeWeeklyStaffingRequirements } from "../lib/planning/weekly-requirements";
import { CONFIG } from "../lib/seed-data";
import { Flight } from "../lib/types";

function makeFlight(overrides: Partial<Flight>): Flight {
  return {
    id: "f1", flight_number: "AT100", airline: "Royal Air Maroc", route: "CMN → X",
    origin: "CMN", destination: "X", aircraft: "Boeing 737-800", equipment_code: null,
    registration: null, callsign: null, terminal: "T1", scheduled_departure: "14:00",
    scheduled_arrival: null, gate: null, boarding_window_start: null, boarding_window_end: null,
    status: "scheduled", booking_pressure: "normal", day_of_week: "Wednesday",
    operator_type: "atlas_managed", destination_category: "Europe/Schengen",
    booked_passengers: null, seat_capacity: null,
    ...overrides,
  };
}

describe("classifyFlightRequirements — a flight now produces MULTIPLE concurrent requirements, not one merged number", () => {
  it("Europe/Schengen, standard aircraft: Gate x1 + Boarding x1 + Profiling x1", () => {
    const reqs = classifyFlightRequirements(makeFlight({}), CONFIG);
    const byRole = Object.fromEntries(reqs.map((r) => [r.role, r]));
    expect(Object.keys(byRole).sort()).toEqual(["Boarding", "Gate", "Profiling"]);
    expect(byRole.Gate.total_requirement).toBe(1);
    expect(byRole.Boarding.total_requirement).toBe(1);
    expect(byRole.Profiling.total_requirement).toBe(1);
    expect(reqs.every((r) => r.needs_configuration === false)).toBe(true);
  });

  it("Europe/Schengen, Dreamliner: everything doubles", () => {
    const reqs = classifyFlightRequirements(makeFlight({ aircraft: "Boeing 787-9" }), CONFIG);
    const byRole = Object.fromEntries(reqs.map((r) => [r.role, r]));
    expect(byRole.Gate.total_requirement).toBe(2);
    expect(byRole.Boarding.total_requirement).toBe(2);
    expect(byRole.Profiling.total_requirement).toBe(2);
  });

  it("Africa, standard aircraft: Gate x1 + Boarding x1 only — no Profiling row at all (not applicable, not a gap)", () => {
    const reqs = classifyFlightRequirements(makeFlight({ destination_category: "Africa" }), CONFIG);
    const byRole = Object.fromEntries(reqs.map((r) => [r.role, r]));
    expect(Object.keys(byRole).sort()).toEqual(["Boarding", "Gate"]);
    expect(byRole.Gate.total_requirement).toBe(1);
    expect(byRole.Boarding.total_requirement).toBe(1);
  });

  it("Africa, Dreamliner: Gate x2 + Boarding x2 only", () => {
    const reqs = classifyFlightRequirements(makeFlight({ destination_category: "Africa", aircraft: "Boeing 787-9" }), CONFIG);
    const byRole = Object.fromEntries(reqs.map((r) => [r.role, r]));
    expect(byRole.Gate.total_requirement).toBe(2);
    expect(byRole.Boarding.total_requirement).toBe(2);
    expect(byRole.Profiling).toBeUndefined();
  });

  it("UK/USA, standard aircraft: Gate x1 + Boarding x1 + Profiling x1 + Mesure x4 (all real, confirmed requirements)", () => {
    const reqs = classifyFlightRequirements(makeFlight({ destination_category: "UK/USA" }), CONFIG);
    const byRole = Object.fromEntries(reqs.map((r) => [r.role, r]));
    expect(Object.keys(byRole).sort()).toEqual(["Boarding", "Gate", "Mesure", "Profiling"]);
    expect(byRole.Gate.total_requirement).toBe(1);
    expect(byRole.Boarding.total_requirement).toBe(1);
    expect(byRole.Profiling.total_requirement).toBe(1);
    expect(byRole.Mesure.total_requirement).toBe(4);
    expect(byRole.Mesure.needs_configuration).toBe(false);
    expect(reqs.every((r) => r.needs_configuration === false)).toBe(true);
  });

  it("UK/USA, Dreamliner: Gate/Boarding/Profiling double, but Mesure stays 4 — destination-driven, never aircraft-driven", () => {
    const reqs = classifyFlightRequirements(makeFlight({ destination_category: "UK/USA", aircraft: "Boeing 787-9" }), CONFIG);
    const byRole = Object.fromEntries(reqs.map((r) => [r.role, r]));
    expect(byRole.Gate.total_requirement).toBe(2);
    expect(byRole.Boarding.total_requirement).toBe(2);
    expect(byRole.Profiling.total_requirement).toBe(2);
    expect(byRole.Mesure.total_requirement).toBe(4);
    expect(byRole.Mesure.needs_configuration).toBe(false);
  });

  it("an entirely unconfigured destination category collapses to ONE needs_configuration row, not one per role", () => {
    const reqs = classifyFlightRequirements(makeFlight({ destination_category: "Domestic" }), CONFIG);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].needs_configuration).toBe(true);
    expect(reqs[0].total_requirement).toBe(0);
  });

  it("self-managed (foreign carrier) flights are untouched by the RAM matrix — still one company_config row", () => {
    const reqs = classifyFlightRequirements(
      makeFlight({ operator_type: "self_managed", airline: "Emirates", destination_category: null }),
      CONFIG
    );
    expect(reqs).toHaveLength(1);
    expect(reqs[0].source).toBe("company_config");
  });

  it("Canada: same confirmed treatment as UK/USA — Gate x1 + Boarding x1 + Profiling x1 + Mesure x4, all real requirements", () => {
    const reqs = classifyFlightRequirements(makeFlight({ destination_category: "Canada" }), CONFIG);
    const byRole = Object.fromEntries(reqs.map((r) => [r.role, r]));
    expect(Object.keys(byRole).sort()).toEqual(["Boarding", "Gate", "Mesure", "Profiling"]);
    expect(byRole.Gate.total_requirement).toBe(1);
    expect(byRole.Boarding.total_requirement).toBe(1);
    expect(byRole.Profiling.total_requirement).toBe(1);
    expect(byRole.Mesure.total_requirement).toBe(4);
    expect(byRole.Mesure.needs_configuration).toBe(false);
  });

  it("an UNMANAGED self-managed carrier (no COMPANY_STAFFING_CONFIG entry) produces NO requirement at all — no fabricated needs_configuration row", () => {
    const reqs = classifyFlightRequirements(
      makeFlight({ operator_type: "self_managed", airline: "Turkish Airlines", destination_category: null }),
      CONFIG
    );
    expect(reqs).toEqual([]);
  });
});

describe("computeWeeklyStaffingRequirements — deterministic, distinct ids across multiple roles for the same flight", () => {
  it("gives every role its own id, all traceable back to the same flight_id", () => {
    const reqs = computeWeeklyStaffingRequirements([makeFlight({ id: "at100-wed" })], CONFIG);
    expect(reqs.length).toBeGreaterThan(1);
    expect(reqs.every((r) => r.flight_id === "at100-wed")).toBe(true);
    const ids = reqs.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length); // all unique
    expect(ids).toContain("req-at100-wed-gate");
    expect(ids).toContain("req-at100-wed-boarding");
    expect(ids).toContain("req-at100-wed-profiling");
  });
});
