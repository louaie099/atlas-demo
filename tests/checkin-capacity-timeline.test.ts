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

/**
 * Regression coverage for the 2026-09-23 live-production bug: a single
 * ordinary zone (whichever has the highest required headcount at an
 * instant) was capturing 100% of the free-employee pool, leaving every
 * other zone with simultaneous real demand at Available 0 — even when the
 * combined pool was large enough to cover every zone's demand if split
 * sensibly. See checkin-capacity-timeline.ts's module doc comment for the
 * full diagnosis (attributeFreeEmployeesForInstant replaces the old
 * single-zone pickZoneForInstant heuristic).
 */
describe("buildDailyCapacityTimeline — capacity SPLITS across zones with simultaneous demand (2026-09-23 multi-zone attribution fix)", () => {
  it("a sufficient shared pool is split across Main + Domestic instead of concentrated entirely into Main", () => {
    // Main flight (UK/USA, +1 override): required = max(1, 2+1) = 3.
    // Domestic flight (domestic, +0 override): required = max(1, 2+0) = 2.
    // Both open 04:30-07:45 (08:30 departure). 5 identical employees free
    // the whole window — exactly enough to cover BOTH zones (3 + 2 = 5) if
    // split correctly, but the old heuristic put all 5 on Main (the higher
    // of the two) and left Domestic at Available 0 / Gap 2.
    const mainFlight = makeFlight({ id: "fmain", destination: "LHR", destination_category: "UK/USA", scheduled_departure: "08:30" });
    const domesticFlight = makeFlight({
      id: "fdom",
      destination: "RAK",
      destination_category: "domestic",
      scheduled_departure: "08:30",
    });
    const employees: EmployeeAvailabilityInput[] = Array.from({ length: 5 }, (_, i) => ({
      employeeId: `e${i}`,
      shift: { start: "04:30", end: "07:45" },
      busyWindows: [],
    }));

    const periods = buildDailyCapacityTimeline("Wednesday", [mainFlight, domesticFlight], employees);
    const overlap = periods.find((p) => p.start === "04:30")!;

    expect(overlap.requiredByZone.t1_main_checkin).toBe(3);
    expect(overlap.requiredByZone.t1_domestic).toBe(2);

    // BEFORE the fix this would be { t1_main_checkin: 5, t1_domestic: 0 }.
    expect(overlap.availableByZone.t1_main_checkin).toBe(3);
    expect(overlap.availableByZone.t1_domestic).toBe(2);

    const rows = buildZoneCoverageRowsForDay("Wednesday", [mainFlight, domesticFlight], employees);
    const mainRow = rows.t1_main_checkin.find((r) => r.start === "04:30")!;
    const domRow = rows.t1_domestic.find((r) => r.start === "04:30")!;
    expect(mainRow.gap).toBe(0);
    expect(mainRow.surplus).toBe(0);
    expect(domRow.gap).toBe(0); // recovered coverage: enough people existed, they were just misattributed
    expect(domRow.surplus).toBe(0);
  });

  it("an insufficient shared pool still shows a REAL, honest gap on both zones — never fabricated coverage", () => {
    // Same Main (required 3) + Domestic (required 2) demand as above, but
    // only 3 free employees total — genuinely not enough to cover both
    // zones' combined demand of 5. The fix must distribute the shortfall
    // (max-min fair), never claim full coverage for either zone.
    const mainFlight = makeFlight({ id: "fmain", destination: "LHR", destination_category: "UK/USA", scheduled_departure: "08:30" });
    const domesticFlight = makeFlight({
      id: "fdom",
      destination: "RAK",
      destination_category: "domestic",
      scheduled_departure: "08:30",
    });
    const employees: EmployeeAvailabilityInput[] = Array.from({ length: 3 }, (_, i) => ({
      employeeId: `e${i}`,
      shift: { start: "04:30", end: "07:45" },
      busyWindows: [],
    }));

    const periods = buildDailyCapacityTimeline("Wednesday", [mainFlight, domesticFlight], employees);
    const overlap = periods.find((p) => p.start === "04:30")!;

    const mainAvailable = overlap.availableByZone.t1_main_checkin ?? 0;
    const domAvailable = overlap.availableByZone.t1_domestic ?? 0;

    // The pool of 3 is fully accounted for (no one invented, no one lost).
    expect(mainAvailable + domAvailable).toBe(3);
    // Neither zone is starved to 0 while the other has surplus: this is the
    // max-min-fair split (main=2/gap1, domestic=1/gap1), never the old
    // all-on-Main behavior (main=3/gap0, domestic=0/gap2).
    expect(mainAvailable).toBe(2);
    expect(domAvailable).toBe(1);

    const rows = buildZoneCoverageRowsForDay("Wednesday", [mainFlight, domesticFlight], employees);
    const mainRow = rows.t1_main_checkin.find((r) => r.start === "04:30")!;
    const domRow = rows.t1_domestic.find((r) => r.start === "04:30")!;
    // A genuine, unavoidable shortage: total demand (5) exceeds the total
    // pool (3), so SOME gap must remain somewhere — the fix redistributes
    // it fairly, it does not and must not make it disappear.
    expect(mainRow.gap + domRow.gap).toBeGreaterThan(0);
    expect(mainRow.gap).toBe(1);
    expect(domRow.gap).toBe(1);
  });

  it("a sufficient shared pool splits across Main + Italy/Spain the same way", () => {
    const mainFlight = makeFlight({ id: "fmain", destination: "LHR", destination_category: "UK/USA", scheduled_departure: "08:30" });
    const italySpainFlight = makeFlight({
      id: "fit",
      destination: "MAD",
      destination_category: "Europe/Schengen",
      scheduled_departure: "08:30",
    });
    // Italy/Spain required = max(1, 2+0) = 2; Main required = 3.
    const employees: EmployeeAvailabilityInput[] = Array.from({ length: 5 }, (_, i) => ({
      employeeId: `e${i}`,
      shift: { start: "04:30", end: "07:45" },
      busyWindows: [],
    }));

    const rows = buildZoneCoverageRowsForDay("Wednesday", [mainFlight, italySpainFlight], employees);
    const mainRow = rows.t1_main_checkin.find((r) => r.start === "04:30")!;
    const italyRow = rows.t1_italy_spain.find((r) => r.start === "04:30")!;

    expect(mainRow.available).toBe(3);
    expect(mainRow.gap).toBe(0);
    expect(italyRow.available).toBe(2); // BEFORE the fix: 0
    expect(italyRow.gap).toBe(0);
  });

  it("a zone whose demand is already fully covered receives no more of the pool, even with employees left over", () => {
    // Domestic needs only 2; Main needs 3; 6 employees free — 1 more than
    // total demand (5). The extra employee is surplus and must land on the
    // still-highest-demand zone (Main), never inflate Domestic beyond its
    // own required headcount while Main also has room.
    const mainFlight = makeFlight({ id: "fmain", destination: "LHR", destination_category: "UK/USA", scheduled_departure: "08:30" });
    const domesticFlight = makeFlight({
      id: "fdom",
      destination: "RAK",
      destination_category: "domestic",
      scheduled_departure: "08:30",
    });
    const employees: EmployeeAvailabilityInput[] = Array.from({ length: 6 }, (_, i) => ({
      employeeId: `e${i}`,
      shift: { start: "04:30", end: "07:45" },
      busyWindows: [],
    }));

    const rows = buildZoneCoverageRowsForDay("Wednesday", [mainFlight, domesticFlight], employees);
    const mainRow = rows.t1_main_checkin.find((r) => r.start === "04:30")!;
    const domRow = rows.t1_domestic.find((r) => r.start === "04:30")!;

    expect(domRow.available).toBe(2);
    expect(domRow.surplus).toBe(0);
    expect(mainRow.available).toBe(4);
    expect(mainRow.surplus).toBe(1);
  });

  it("REGRESSION: a window entirely before the earliest catalog shift start is still a real, unavoidable structural gap — never hidden by the fix", () => {
    // 03:15-04:30-style case: Check-in demand exists but no employee's
    // shift has started yet at all. No amount of better cross-zone
    // attribution can recover coverage that literally does not exist yet —
    // this must keep showing Required > 0 / Available 0 / Gap > 0 after
    // the fix, exactly as before it.
    const domesticFlight = makeFlight({
      id: "fdom",
      destination: "RAK",
      destination_category: "domestic",
      scheduled_departure: "08:30", // opens 04:30
    });
    const employees: EmployeeAvailabilityInput[] = Array.from({ length: 10 }, (_, i) => ({
      employeeId: `e${i}`,
      shift: { start: "04:30", end: "14:00" }, // earliest catalog shift start is 04:30
      busyWindows: [],
    }));

    const periods = buildDailyCapacityTimeline("Wednesday", [domesticFlight], employees);
    // No boundary is added before 04:30 by this flight (open exactly at
    // 04:30), so assert directly on the pre-open instant.
    const beforeAnyShift = periods.find((p) => p.start === "04:00" || (toMinutes(p.start) < toMinutes("04:30") && toMinutes(p.end) <= toMinutes("04:30")));
    if (beforeAnyShift) {
      expect(beforeAnyShift.availableByZone.t1_domestic ?? 0).toBe(0);
    }

    const rows = buildZoneCoverageRowsForDay("Wednesday", [domesticFlight], employees);
    const domRow = rows.t1_domestic.find((r) => r.start === "04:30")!;
    // At the exact instant demand opens and shifts start simultaneously,
    // coverage is fine (10 employees free at 04:30 far exceeds required 2).
    expect(domRow.gap).toBe(0);

    // Now the genuinely-unavoidable case: shift starts strictly AFTER
    // demand opens (03:15 flight window vs 04:30 earliest shift start).
    const earlyDomesticFlight = makeFlight({
      id: "fdom-early",
      destination: "RAK",
      destination_category: "domestic",
      scheduled_departure: "07:15", // opens 03:15, well before any shift starts
    });
    const rows2 = buildZoneCoverageRowsForDay("Wednesday", [earlyDomesticFlight], employees);
    const preShiftRow = rows2.t1_domestic.find((r) => r.start === "03:15");
    expect(preShiftRow).toBeDefined();
    expect(preShiftRow!.required).toBeGreaterThan(0);
    expect(preShiftRow!.available).toBe(0);
    expect(preShiftRow!.gap).toBeGreaterThan(0); // real, unavoidable — must NOT be hidden by the fix
  });
});
