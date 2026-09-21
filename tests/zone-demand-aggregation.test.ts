import { describe, it, expect } from "vitest";
import { aggregateZoneDailyDemand, zoneDemandClusters } from "../lib/planning/zone-demand-aggregation";
import { Flight } from "../lib/types";

function makeFlight(overrides: Partial<Flight>): Flight {
  return {
    id: "f1", flight_number: "AT100", airline: "Royal Air Maroc", route: "CMN → X",
    origin: "CMN", destination: "LHR", aircraft: "Boeing 737-800", equipment_code: null,
    registration: null, callsign: null, terminal: "T1", scheduled_departure: "10:00",
    scheduled_arrival: null, gate: null, boarding_window_start: null, boarding_window_end: null,
    status: "scheduled", booking_pressure: "normal", day_of_week: "Wednesday", flight_date: "2026-09-03", week_start: "2026-09-01",
    operator_type: "atlas_managed", destination_category: "UK/USA",
    booked_passengers: null, seat_capacity: null,
    ...overrides,
  };
}

describe("aggregateZoneDailyDemand", () => {
  it("applies the shared base_agents ONCE for a bucket with several simultaneous flights in the same zone, not once per flight", () => {
    // Both flights depart at 10:00 -> Check-in window 07:00-09:15 for both,
    // fully overlapping. Domestic category override is 0, so each flight's
    // own increment is 0 -- if base were summed per flight this would be
    // 2*2=4; aggregated correctly it must stay at the single shared base (2).
    const flightA = makeFlight({ id: "a", destination: "RAK", destination_category: null, scheduled_departure: "10:00" });
    const flightB = makeFlight({ id: "b", destination: "RAK", destination_category: null, scheduled_departure: "10:00" });

    const demand = aggregateZoneDailyDemand("Wednesday", "t1_domestic", [flightA, flightB]);
    const activeBucket = demand.buckets.find((b) => b.start === "08:00")!;
    expect(activeBucket.required).toBe(2); // shared base, not 2x
    expect(activeBucket.contributingFlightIds.sort()).toEqual(["a", "b"]);
  });

  it("sums each flight's own incremental complexity on top of the single shared base", () => {
    // UK/USA category override is +1 each; two simultaneous UK/USA flights ->
    // base 2 + 1 + 1 = 4.
    const flightA = makeFlight({ id: "a", scheduled_departure: "10:00" });
    const flightB = makeFlight({ id: "b", scheduled_departure: "10:00" });

    const demand = aggregateZoneDailyDemand("Wednesday", "t1_main_checkin", [flightA, flightB]);
    const activeBucket = demand.buckets.find((b) => b.start === "08:00")!;
    expect(activeBucket.required).toBe(4);
  });

  it("never assigns a Business/Staff/Oversized zone any automatic demand", () => {
    const flight = makeFlight({ scheduled_departure: "10:00" });
    const demand = aggregateZoneDailyDemand("Wednesday", "t1_business_checkin", [flight]);
    expect(demand.buckets.every((b) => b.required === 0)).toBe(true);
  });

  it("keeps a Spain-destined flight's demand entirely inside t1_italy_spain, not t1_main_checkin", () => {
    const flight = makeFlight({ id: "a", destination: "MAD", destination_category: "Europe/Schengen", scheduled_departure: "10:00" });
    const mainDemand = aggregateZoneDailyDemand("Wednesday", "t1_main_checkin", [flight]);
    const italySpainDemand = aggregateZoneDailyDemand("Wednesday", "t1_italy_spain", [flight]);
    expect(mainDemand.buckets.every((b) => b.required === 0)).toBe(true);
    expect(italySpainDemand.buckets.some((b) => b.required > 0)).toBe(true);
  });

  it("zero flights in a zone/day produces all-zero buckets and no clusters", () => {
    const demand = aggregateZoneDailyDemand("Wednesday", "t1_main_checkin", []);
    expect(demand.buckets.every((b) => b.required === 0)).toBe(true);
    expect(zoneDemandClusters(demand)).toEqual([]);
  });
});

describe("zoneDemandClusters", () => {
  it("splits two non-adjacent flights' zone demand into two separate clusters", () => {
    const flightA = makeFlight({ id: "a", scheduled_departure: "08:00" });
    const flightB = makeFlight({ id: "b", scheduled_departure: "20:00" });
    const demand = aggregateZoneDailyDemand("Wednesday", "t1_main_checkin", [flightA, flightB]);
    const clusters = zoneDemandClusters(demand);
    expect(clusters.length).toBe(2);
    expect(clusters[0].contributingFlightIds).toEqual(["a"]);
    expect(clusters[1].contributingFlightIds).toEqual(["b"]);
  });
});
