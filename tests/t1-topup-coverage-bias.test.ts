import { describe, it, expect } from "vitest";
import {
  computeEmployeeDayCountTopUp,
  generateObligationToppedUpShifts,
  buildRemainingT1ZoneGaps,
  T1ZoneWindowGap,
} from "../lib/planning/roster-generation";
import { GeneratedShiftAssignment } from "../lib/planning/shift-generation";
import { Employee } from "../lib/types";
import { CONFIG } from "../lib/seed-data";

// Post-2026-09-20 (GMT) regime week, matching this codebase's other
// new-regime fixtures (e.g. foreign-company-roster-topup.test.ts). Catalog
// (lib/shift-templates.ts, SHIFT_CODES_GMT_EFFECTIVE_2026_09_20):
//   MT03 05:45-14:45 (9h00)   NR01 08:00-17:00 (9h00)   AP01 13:45-22:45 (9h00)
// MT03/NR01/AP01 tie for shortest non-overnight duration; shortest-first
// catalog order (and so the pre-feature default pick) is MT03, then NR01,
// then AP01.
const TEST_WEEK_START = "2026-09-21"; // a Monday

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "emp",
    name: "Test",
    skills: ["Check-in"],
    assignment: "General T1 Pool",
    shift_code: null,
    shift_start: null,
    shift_end: null,
    rest_before_shift_hours: null,
    weekly_hours: null,
    is_duty_officer: false,
    off_days: [],
    foreign_company_authorizations: [],
    active: true,
    weekly_shifts: [],
    ...overrides,
  };
}

describe("buildRemainingT1ZoneGaps — baseline remaining T1 demand before the top-up runs", () => {
  const zoneRequirements = [{ zone: "Main", window_start: "09:00", window_end: "16:00", required_headcount: 2 }];

  it("subtracts an already-committed, Check-in-eligible employee's shift when it FULLY contains the window", () => {
    const committed: GeneratedShiftAssignment[] = [{ employeeId: "e1", dayOfWeek: "Monday", shiftCode: "NR01", coversRoles: [] }]; // 08:00-17:00 fully contains 09:00-16:00
    const employees = [makeEmployee({ id: "e1" })];
    const gaps = buildRemainingT1ZoneGaps(TEST_WEEK_START, "Monday", zoneRequirements, committed, employees);
    expect(gaps).toEqual([{ zone: "Main", windowStart: "09:00", windowEnd: "16:00", remaining: 1 }]);
  });

  it("does NOT credit a shift that only PARTIALLY overlaps the window (requirement #4: full-window coverage only)", () => {
    const committed: GeneratedShiftAssignment[] = [{ employeeId: "e1", dayOfWeek: "Monday", shiftCode: "AP01", coversRoles: [] }]; // 13:45-22:45 overlaps but starts after 09:00 -- not full containment
    const employees = [makeEmployee({ id: "e1" })];
    const gaps = buildRemainingT1ZoneGaps(TEST_WEEK_START, "Monday", zoneRequirements, committed, employees);
    expect(gaps[0].remaining).toBe(2); // unchanged -- partial overlap earns nothing
  });

  it("never credits an employee who isn't Check-in eligible, even with a fully-covering shift (avoids double-counting Profiling/Mesure/foreign-company/no-skill employees)", () => {
    const committed: GeneratedShiftAssignment[] = [{ employeeId: "e1", dayOfWeek: "Monday", shiftCode: "NR01", coversRoles: [] }];
    const employees = [makeEmployee({ id: "e1", assignment: "Profiling" })]; // Profiling-assigned -> isEligibleForDefaultCheckinPlacement is false
    const gaps = buildRemainingT1ZoneGaps(TEST_WEEK_START, "Monday", zoneRequirements, committed, employees);
    expect(gaps[0].remaining).toBe(2); // unchanged
  });

  it("never goes negative, even with more covering capacity than required", () => {
    const committed: GeneratedShiftAssignment[] = [
      { employeeId: "e1", dayOfWeek: "Monday", shiftCode: "NR01", coversRoles: [] },
      { employeeId: "e2", dayOfWeek: "Monday", shiftCode: "MT03", coversRoles: [] }, // 05:45-14:45 does NOT fully contain 09:00-16:00 (ends too early) -- only e1 actually credits here
      { employeeId: "e3", dayOfWeek: "Monday", shiftCode: "NR01", coversRoles: [] },
    ];
    const employees = [makeEmployee({ id: "e1" }), makeEmployee({ id: "e2" }), makeEmployee({ id: "e3" })];
    const gaps = buildRemainingT1ZoneGaps(TEST_WEEK_START, "Monday", zoneRequirements, committed, employees);
    expect(gaps[0].remaining).toBe(0); // floored at 0, not -0 or negative
  });
});

describe("computeEmployeeDayCountTopUp — T1 zone/window coverage bias", () => {
  const daysOrder = ["Monday"];

  it("without t1Coverage supplied, picks the shortest-first legal code exactly as before (MT03) -- byte-identical regression safety", () => {
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
      null
      // t1PeakDemandMinuteByDay, preferredOffWindowStart, fatigue, hardCaps, t1Coverage all omitted
    );
    expect(additions.get("Monday")).toBe("MT03");
  });

  it("with a real remaining T1 gap only MT03/NR01's/AP01's FULL window can close, prefers the covering code (NR01) over shortest-first (MT03)", () => {
    const remainingByDay: Record<string, T1ZoneWindowGap[]> = {
      Monday: [{ zone: "Main", windowStart: "09:00", windowEnd: "16:00", remaining: 1 }],
    };
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
      undefined, // t1PeakDemandMinuteByDay
      undefined, // preferredOffWindowStart
      undefined, // fatigue
      undefined, // hardCaps
      { remainingByDay, employeeEligible: true }
    );
    expect(additions.get("Monday")).toBe("NR01"); // MT03 (05:45-14:45) does not fully cover 09:00-16:00; NR01 (08:00-17:00) does
    expect(remainingByDay.Monday[0].remaining).toBe(0); // decremented as part of the real commit
  });

  it("an employee who is NOT T1-eligible never gets the bias, even with a real gap supplied (employeeEligible: false)", () => {
    const remainingByDay: Record<string, T1ZoneWindowGap[]> = {
      Monday: [{ zone: "Main", windowStart: "09:00", windowEnd: "16:00", remaining: 1 }],
    };
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
      undefined,
      undefined,
      undefined,
      undefined,
      { remainingByDay, employeeEligible: false }
    );
    expect(additions.get("Monday")).toBe("MT03"); // falls back to shortest-first
    expect(remainingByDay.Monday[0].remaining).toBe(1); // untouched
  });

  it("never picks a rest-illegal code just because it would cover a T1 gap (never overrides a hard constraint)", () => {
    // Day 0 already worked NR02 (08:00-18:15); entering NR01 (08:00) the very
    // next day would violate 15h rest even though NR01 would otherwise close
    // the T1 gap below -- the bias must still only choose among already-legal
    // candidates.
    const twoDays = ["Monday", "Tuesday"];
    const remainingByDay: Record<string, T1ZoneWindowGap[]> = {
      Tuesday: [{ zone: "Main", windowStart: "09:00", windowEnd: "16:00", remaining: 1 }],
    };
    const additions = computeEmployeeDayCountTopUp(
      "e1",
      twoDays,
      TEST_WEEK_START,
      new Set(["Monday"]),
      10.25,
      (day) => (day === "Monday" ? { shiftCode: "NR02" } : undefined),
      new Map(),
      15,
      2,
      0,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      { remainingByDay, employeeEligible: true }
    );
    const tuesdayCode = additions.get("Tuesday");
    expect(tuesdayCode).toBeDefined();
    expect(tuesdayCode).not.toBe("NR01"); // would violate rest against Monday's NR02
  });
});

describe("generateObligationToppedUpShifts — cross-employee greedy T1 coverage spreading", () => {
  // 3 days so the normal roster target (daysOrder.length - normal_weekly_off_days,
  // with the confirmed normal_weekly_off_days = 2) is a real positive number
  // (1) and the top-up actually has a day to add -- a 1-day window would
  // compute a target of 0 and never run at all.
  const daysOrder = ["Monday", "Tuesday", "Wednesday"];

  it("the first eligible employee processed closes a real T1 gap; the SECOND employee (same pass, same day) sees it already closed and falls back to the default pick -- proving the shared remaining-gap state actually decrements across employees", () => {
    const employees = [makeEmployee({ id: "e1" }), makeEmployee({ id: "e2" })];
    // The SAME gap on every day of the window: with no fatigue/preference
    // inputs, which single day gets worked (target 1 of 3) is decided
    // identically (employee-blind) for e1 and e2, so they always land on
    // the SAME day -- put the gap everywhere so the assertions below don't
    // need to predict which one that is.
    const remainingT1ZoneGapsByDay: Record<string, T1ZoneWindowGap[]> = {
      Monday: [{ zone: "Main", windowStart: "09:00", windowEnd: "16:00", remaining: 1 }],
      Tuesday: [{ zone: "Main", windowStart: "09:00", windowEnd: "16:00", remaining: 1 }],
      Wednesday: [{ zone: "Main", windowStart: "09:00", windowEnd: "16:00", remaining: 1 }],
    };
    const result = generateObligationToppedUpShifts(
      daysOrder,
      employees,
      {}, // no demand-driven shifts at all -- both employees are topped up from scratch
      CONFIG,
      new Map(),
      15,
      TEST_WEEK_START,
      undefined,
      undefined,
      undefined,
      undefined,
      remainingT1ZoneGapsByDay
    );
    const workedDays = daysOrder.filter((d) => result[d].length > 0);
    expect(workedDays).toHaveLength(1); // target 1 of 3 -- both employees land on the same single day
    const workedDay = workedDays[0];
    const onDay = result[workedDay];
    expect(onDay).toHaveLength(2);
    const e1 = onDay.find((g) => g.employeeId === "e1")!;
    const e2 = onDay.find((g) => g.employeeId === "e2")!;
    expect(e1.shiftCode).toBe("NR01"); // closes the one remaining slot
    expect(e1.t1CoverageReason).toBeDefined();
    expect(e1.t1CoverageReason).toContain("Main");
    expect(e2.shiftCode).toBe("MT03"); // the window is already at remaining=0 by the time e2 is processed -- falls back to shortest-first
    expect(e2.t1CoverageReason).toBeUndefined();
    expect(remainingT1ZoneGapsByDay[workedDay][0].remaining).toBe(0);
    // The OTHER two days' gaps were never touched -- nobody worked them.
    for (const d of daysOrder.filter((d) => d !== workedDay)) expect(remainingT1ZoneGapsByDay[d][0].remaining).toBe(1);
  });

  it("omitting remainingT1ZoneGapsByDay reproduces the exact prior (shortest-first) output for every employee -- full backward compatibility", () => {
    const employees = [makeEmployee({ id: "e1" }), makeEmployee({ id: "e2" })];
    const result = generateObligationToppedUpShifts(daysOrder, employees, {}, CONFIG, new Map(), 15, TEST_WEEK_START);
    const allAssignments = daysOrder.flatMap((d) => result[d]);
    expect(allAssignments).toHaveLength(2); // one worked day each, target 1 of 3
    expect(allAssignments.every((g) => g.shiftCode === "MT03")).toBe(true);
    expect(allAssignments.every((g) => g.t1CoverageReason === undefined)).toBe(true);
  });
});
