import { describe, it, expect } from "vitest";
import { computeEmployeeDayCountTopUp } from "../lib/planning/roster-generation";

// Pre-boundary Monday (before the 2026-09-20 GMT+1 -> GMT regime change) --
// these tests assert on OLD-regime catalog codes/durations (e.g. NR01's
// 8h45), so a consistent OLD-regime week is used throughout.
const TEST_WEEK_START = "2026-01-05";

/**
 * Stage-6 T1-demand heuristic bias (2026-09-23, product owner's point 9):
 * when a legally-rested-either-way choice exists between catalog codes,
 * the day's known aggregate T1 demand peak (computed on the flight
 * schedule alone, BEFORE Stage 6 runs — see generate-draft-plan.ts and
 * zone-demand-aggregation.ts's peakAggregateT1DemandMinuteForDay) should
 * bias the pick toward a code that actually covers it, instead of always
 * the shortest-first code. This must NEVER change which days a hard
 * rest/consecutive-OFF/obligation constraint would otherwise forbid — only
 * WHICH already-legal code is picked for a day being added anyway.
 */
describe("computeEmployeeDayCountTopUp — Stage-6 T1 demand heuristic bias", () => {
  const daysOrder = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  it("without a peak-demand hint, picks the shortest-first legal code exactly as before (NR01, unchanged default behavior)", () => {
    const additions = computeEmployeeDayCountTopUp(
      "e1",
      daysOrder,
      TEST_WEEK_START,
      new Set(), // no scheduled days at all
      0,
      () => undefined, // no existing shift any day
      new Map(),
      15,
      1, // target 1 working day
      2,
      null
      // t1PeakDemandMinuteByDay omitted
    );
    expect(additions.size).toBe(1);
    const [, code] = Array.from(additions.entries())[0];
    expect(code).toBe("NR01"); // shortest legal code (8h45) in the default catalog order
  });

  it("with a peak-demand hint the shortest-first code does NOT cover, biases toward a legal code that DOES cover it (MT02, covering 05:00)", () => {
    const t1PeakDemandMinuteByDay: Record<string, number | null> = {};
    for (const day of daysOrder) t1PeakDemandMinuteByDay[day] = 5 * 60; // 05:00 every day

    const additions = computeEmployeeDayCountTopUp(
      "e1",
      daysOrder,
      TEST_WEEK_START,
      new Set(),
      0,
      () => undefined,
      new Map(),
      15,
      1,
      2,
      null,
      t1PeakDemandMinuteByDay
    );
    expect(additions.size).toBe(1);
    const [day, code] = Array.from(additions.entries())[0];
    // NR01 (08:00-16:45) does NOT cover 05:00 -- MT02 (04:30-14:45) does,
    // and is the first legal candidate (in shortest-first order) that does.
    expect(code).toBe("MT02");
    expect(daysOrder).toContain(day);
  });

  it("never overrides a hard rest constraint: a peak hint pointing at a code that would violate rest against the prior day's shift is skipped, falling back to a legal code", () => {
    // Prior day (index 0) already worked JR01 (05:45-18:15) -- entering
    // MT02 (04:30) the very next day would violate 15h rest; the bias must
    // never pick an illegal candidate just because it "covers" the peak.
    const t1PeakDemandMinuteByDay: Record<string, number | null> = { Tuesday: 5 * 60 };
    const additions = computeEmployeeDayCountTopUp(
      "e1",
      ["Monday", "Tuesday"],
      TEST_WEEK_START,
      new Set(["Monday"]),
      12.5,
      (day) => (day === "Monday" ? { shiftCode: "JR01" } : undefined),
      new Map(),
      15,
      2,
      0,
      null,
      t1PeakDemandMinuteByDay
    );
    const tuesdayCode = additions.get("Tuesday");
    expect(tuesdayCode).toBeDefined();
    expect(tuesdayCode).not.toBe("MT02"); // would violate rest against Monday's JR01 -- must never be chosen
  });
});
