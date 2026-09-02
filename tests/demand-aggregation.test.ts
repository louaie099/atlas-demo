import { describe, it, expect } from "vitest";
import { aggregateDailyDemand, peakDemandForRole, demandWindowForRole } from "../lib/planning/demand-aggregation";
import { Flight, StaffingRequirement } from "../lib/types";

function makeFlight(overrides: Partial<Flight>): Flight {
  return {
    id: "f1", flight_number: "AT100", airline: "Royal Air Maroc", route: "CMN → X",
    origin: "CMN", destination: "X", aircraft: "Boeing 737-800", equipment_code: null,
    registration: null, callsign: null, terminal: "T1", scheduled_departure: "10:00",
    scheduled_arrival: null, gate: null, boarding_window_start: "09:30", boarding_window_end: "10:00",
    status: "scheduled", booking_pressure: "normal", day_of_week: "Wednesday",
    operator_type: "atlas_managed", destination_category: "Europe/Schengen",
    ...overrides,
  };
}

function makeRequirement(overrides: Partial<StaffingRequirement>): StaffingRequirement {
  return {
    id: "r1", flight_id: "f1", role: "Boarding", baseline_requirement: 3, additional_requirement: 0,
    total_requirement: 3, source: "fixed_rule", reasoning: "", needs_configuration: false,
    ...overrides,
  };
}

describe("aggregateDailyDemand", () => {
  it("sums demand for two non-overlapping flights into separate buckets, not combined", () => {
    const flightA = makeFlight({ id: "a", boarding_window_start: "09:00", boarding_window_end: "09:30" });
    const flightB = makeFlight({ id: "b", boarding_window_start: "14:00", boarding_window_end: "14:30" });
    const reqA = makeRequirement({ id: "ra", flight_id: "a", role: "Boarding", total_requirement: 3 });
    const reqB = makeRequirement({ id: "rb", flight_id: "b", role: "Boarding", total_requirement: 2 });

    const demand = aggregateDailyDemand("Wednesday", [flightA, flightB], [reqA, reqB]);
    expect(peakDemandForRole(demand, "Boarding")).toBe(3); // peak is the larger of the two, since they never overlap
  });

  it("combines demand for two OVERLAPPING flights into a real peak, not just the larger individual requirement", () => {
    const flightA = makeFlight({ id: "a", boarding_window_start: "09:00", boarding_window_end: "10:00" });
    const flightB = makeFlight({ id: "b", boarding_window_start: "09:30", boarding_window_end: "10:30" });
    const reqA = makeRequirement({ id: "ra", flight_id: "a", role: "Boarding", total_requirement: 3 });
    const reqB = makeRequirement({ id: "rb", flight_id: "b", role: "Boarding", total_requirement: 2 });

    const demand = aggregateDailyDemand("Wednesday", [flightA, flightB], [reqA, reqB]);
    // Between 09:30-10:00 both flights need coverage simultaneously: 3 + 2 = 5
    expect(peakDemandForRole(demand, "Boarding")).toBe(5);
  });

  it("excludes needs_configuration requirements from the numeric demand entirely", () => {
    const flightA = makeFlight({ id: "a" });
    const reqA = makeRequirement({ id: "ra", flight_id: "a", needs_configuration: true, total_requirement: 99 });
    const demand = aggregateDailyDemand("Wednesday", [flightA], [reqA]);
    expect(peakDemandForRole(demand, "Boarding")).toBe(0);
  });

  it("only counts flights/requirements for the requested day", () => {
    const wedFlight = makeFlight({ id: "w", day_of_week: "Wednesday" });
    const thuFlight = makeFlight({ id: "t", day_of_week: "Thursday" });
    const reqW = makeRequirement({ id: "rw", flight_id: "w", total_requirement: 3 });
    const reqT = makeRequirement({ id: "rt", flight_id: "t", total_requirement: 10 });

    const demand = aggregateDailyDemand("Wednesday", [wedFlight, thuFlight], [reqW, reqT]);
    expect(peakDemandForRole(demand, "Boarding")).toBe(3);
  });

  it("demandWindowForRole returns null when there's no demand for that role that day", () => {
    const demand = aggregateDailyDemand("Wednesday", [], []);
    expect(demandWindowForRole(demand, "Boarding")).toBeNull();
  });

  it("demandWindowForRole spans from first to last active bucket", () => {
    const flightA = makeFlight({ id: "a", boarding_window_start: "09:00", boarding_window_end: "09:30" });
    const reqA = makeRequirement({ id: "ra", flight_id: "a" });
    const demand = aggregateDailyDemand("Wednesday", [flightA], [reqA]);
    const window = demandWindowForRole(demand, "Boarding");
    expect(window).toEqual({ start: "09:00", end: "09:30" });
  });
});
