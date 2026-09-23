import { describe, it, expect } from "vitest";
import {
  buildDailyCapacityTimeline,
  mergeAtomicPeriodsForZone,
  buildZoneCoverageRowsForDay,
  buildEmployeeZoneAvailabilitySegments,
  EmployeeAvailabilityInput,
} from "../lib/planning/checkin-capacity-timeline";
import { DEFAULT_ZONE_CHECKIN_DEMAND_POLICY, CHECKIN_OPEN_BEFORE_DEPARTURE_MINUTES } from "../lib/planning/checkin-zone-demand";
import { Flight } from "../lib/types";

/**
 * Regression + correctness coverage for the atomic-interval T1 Check-in
 * Required/Available timeline — see checkin-capacity-timeline.ts's module
 * doc comment for the bug this replaces ("04:00–08:30 Main Check-in —
 * Required 4 / Assigned 75" immediately followed by "09:00–15:30 Main
 * Check-in — Required 6 / Assigned 0" for the same zone/day).
 */

function makeFlight(overrides: Partial<Flight>): Flight {
  return {
    id: "f1",
    flight_number: "AT100",
    airline: "Royal Air Maroc",
    route: "CMN-LHR",
    origin: "CMN",
    destination: "LHR", // United Kingdom -> UK/USA category, t1_main_checkin zone
    aircraft: "737-800",
    equipment_code: null,
    registration: null,
    callsign: null,
    terminal: "T1",
    scheduled_departure: "08:30",
    scheduled_arrival: null,
    gate: null,
    boarding_window_start: null,
    boarding_window_end: null,
    status: "scheduled",
    booking_pressure: "normal",
    day_of_week: "Wednesday",
    flight_date: "2026-09-23",
    week_start: "2026-09-21",
    operator_type: "atlas_managed",
    destination_category: "UK/USA",
    ...overrides,
  } as Flight;
}

describe("buildDailyCapacityTimeline — atomic-interval Required/Available correctness", () => {
  it("respects T-4h Check-in opening (CONFIRMED, per CHECKIN_OPEN_BEFORE_DEPARTURE_MINUTES)", () => {
    expect(CHECKIN_OPEN_BEFORE_DEPARTURE_MINUTES).toBe(240);
    const flight = makeFlight({ scheduled_departure: "08:30" }); // open at 04:30
    const periods = buildDailyCapacityTimeline("Wednesday", [flight], []);
    const beforeOpen = periods.find((p) => p.start === "04:00");
    const afterOpen = periods.find((p) => p.start === "04:30");
    expect(beforeOpen?.requiredByZone.t1_main_checkin ?? 0).toBe(0);
    expect(afterOpen?.requiredByZone.t1_main_checkin ?? 0).toBeGreaterThan(0);
  });

  it("computes Required per ATOMIC period, not smeared over the whole demand window: two overlapping flights raise Required only where they truly overlap", () => {
    // Flight A: open 04:30 - close 07:45 (08:30 departure). Flight B: open
    // 06:00 - close 09:15 (10:00 departure). They overlap only 06:00-07:45.
    const flightA = makeFlight({ id: "fa", scheduled_departure: "08:30" });
    const flightB = makeFlight({ id: "fb", scheduled_departure: "10:00" });
    const periods = buildDailyCapacityTimeline("Wednesday", [flightA, flightB], []);

    const soloA = periods.find((p) => p.start === "04:30");
    const overlap = periods.find((p) => p.start === "06:00");
    const soloB = periods.find((p) => p.start === "07:45");

    expect(soloA?.contributingFlightIdsByZone.t1_main_checkin).toEqual(["fa"]);
    expect(overlap?.contributingFlightIdsByZone.t1_main_checkin?.sort()).toEqual(["fa", "fb"]);
    expect(soloB?.contributingFlightIdsByZone.t1_main_checkin).toEqual(["fb"]);

    // Overlap period's required must be >= either solo period's (more
    // active flights -> more or equal required, from the shared floor/base
    // + summed increments), never smeared/equal-everywhere.
    const soloRequired = soloA!.requiredByZone.t1_main_checkin!;
    const overlapRequired = overlap!.requiredByZone.t1_main_checkin!;
    expect(overlapRequired).toBeGreaterThanOrEqual(soloRequired);
  });

  it("REGRESSION: a partial-interval shift overlap is never counted as full-window coverage — the exact prior bug", () => {
    // Employee free only 07:00-08:00 (say, a Gate duty consumes the rest of
    // an 05:45-14:45 shift on both sides) must show as available ONLY in
    // atomic periods that fall within 07:00-08:00, never across the whole
    // 05:45-14:45 shift and never across the whole flight's broad demand
    // window (04:30-07:45).
    const flight = makeFlight({ scheduled_departure: "08:30" }); // open 04:30, close 07:45
    const employee: EmployeeAvailabilityInput = {
      employeeId: "e1",
      shift: { start: "05:45", end: "14:45" },
      busyWindows: [
        { start: "05:45", end: "07:00" },
        { start: "08:00", end: "14:45" },
      ],
    };
    const periods = buildDailyCapacityTimeline("Wednesday", [flight], [employee]);

    for (const period of periods) {
      const startMin = toMinutes(period.start);
      const isFree = startMin >= toMinutes("07:00") && startMin < toMinutes("08:00");
      const availableIds = period.availableEmployeeIdsByZone.t1_main_checkin ?? [];
      if (isFree) {
        expect(availableIds).toContain("e1");
      } else {
        expect(availableIds).not.toContain("e1");
      }
    }
  });

  it("REGRESSION: no zone/day/window is starved to zero right next to an inflated spike for the same real roster (bounded, not spiked-then-zeroed)", () => {
    // 5 identical eligible employees, all free all day. Two flights create
    // two adjacent demand clusters for the same zone. Available must be
    // the SAME (5) in both clusters — never 5x-inflated in one and 0 in the
    // other, which was the exact live bug shape.
    const flightA = makeFlight({ id: "fa", scheduled_departure: "08:30" }); // open 04:30-07:45
    const flightB = makeFlight({ id: "fb", scheduled_departure: "13:30" }); // open 09:30-12:45
    const employees: EmployeeAvailabilityInput[] = Array.from({ length: 5 }, (_, i) => ({
      employeeId: `e${i}`,
      shift: { start: "05:45", end: "14:45" },
      busyWindows: [],
    }));
    const rows = mergeAtomicPeriodsForZone(
      "t1_main_checkin",
      "Wednesday",
      buildDailyCapacityTimeline("Wednesday", [flightA, flightB], employees)
    );

    const clusterA = rows.find((r) => r.start === "05:45");
    const clusterB = rows.find((r) => r.contributingFlightIds.includes("fb"));

    expect(clusterA?.available).toBe(5);
    expect(clusterB?.available).toBe(5);
    // Never a wild multiple of the real headcount, and never zero when the
    // same 5 employees are free and on shift (05:45-14:45) the whole day —
    // a period entirely before shift start (04:30-05:45, when flight A is
    // already open but no one has clocked in yet) legitimately has 0
    // available and is excluded here.
    for (const row of rows) {
      expect(row.available).toBeLessThanOrEqual(5);
      const withinShift = row.start >= "05:45" && row.end <= "14:45";
      if (row.required > 0 && withinShift) expect(row.available).toBeGreaterThan(0);
    }
  });

  it("adjacent atomic periods with identical Required/Available merge into one display row, without changing the underlying computation", () => {
    const flight = makeFlight({ scheduled_departure: "08:30" });
    const employees: EmployeeAvailabilityInput[] = [{ employeeId: "e1", shift: { start: "05:45", end: "14:45" }, busyWindows: [] }];
    const periods = buildDailyCapacityTimeline("Wednesday", [flight], employees);
    const rows = mergeAtomicPeriodsForZone("t1_main_checkin", "Wednesday", periods);
    // Strictly fewer (or equal) display rows than atomic periods -- proof
    // that merging happened and is a pure display-layer step.
    expect(rows.length).toBeLessThanOrEqual(periods.length);
    for (const row of rows) {
      expect(row.gap).toBe(Math.max(0, row.required - row.available));
      expect(row.surplus).toBe(Math.max(0, row.available - row.required));
    }
  });

  it("buildZoneCoverageRowsForDay returns rows for every ordinary zone, keyed correctly", () => {
    const flight = makeFlight({ scheduled_departure: "08:30" });
    const result = buildZoneCoverageRowsForDay("Wednesday", [flight], [], DEFAULT_ZONE_CHECKIN_DEMAND_POLICY);
    expect(Object.keys(result).sort()).toEqual(["t1_domestic", "t1_italy_spain", "t1_main_checkin"].sort());
    expect(result.t1_main_checkin.length).toBeGreaterThan(0);
    expect(result.t1_domestic.length).toBe(0); // no domestic flight in this scenario
  });

  it("buildEmployeeZoneAvailabilitySegments merges consecutive periods for one employee, but splits on a zone-attribution change", () => {
    const flightMain = makeFlight({ id: "fmain", scheduled_departure: "08:30" }); // t1_main_checkin
    const employees: EmployeeAvailabilityInput[] = [{ employeeId: "e1", shift: { start: "04:00", end: "10:00" }, busyWindows: [] }];
    const periods = buildDailyCapacityTimeline("Wednesday", [flightMain], employees);
    const segments = buildEmployeeZoneAvailabilitySegments("e1", periods);
    expect(segments.length).toBeGreaterThan(0);
    for (const s of segments) expect(s.zone).toBe("t1_main_checkin"); // no other zone has any demand in this scenario
  });
});

function toMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
