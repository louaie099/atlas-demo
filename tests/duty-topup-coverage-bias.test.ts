import { describe, it, expect } from "vitest";
import {
  computeEmployeeDayCountTopUp,
  generateObligationToppedUpShifts,
  buildRemainingDutyGaps,
  DutyWindowGap,
} from "../lib/planning/roster-generation";
import { GeneratedShiftAssignment } from "../lib/planning/shift-generation";
import { Employee, Flight, StaffingRequirement } from "../lib/types";
import { CONFIG } from "../lib/seed-data";

// Same post-2026-09-20 (GMT) regime week as t1-topup-coverage-bias.test.ts.
// Catalog (lib/shift-templates.ts, SHIFT_CODES_GMT_EFFECTIVE_2026_09_20):
//   MT03 05:45-14:45 (9h00)   NR01 08:00-17:00 (9h00)   AP01 13:45-22:45 (9h00)
const TEST_WEEK_START = "2026-09-21"; // a Monday

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "emp",
    name: "Test",
    skills: ["Boarding"],
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

function makeFlight(overrides: Partial<Flight>): Flight {
  return {
    id: "f1",
    flight_number: "AT512",
    airline: "Royal Air Maroc",
    route: "CMN → RAK",
    origin: "CMN",
    destination: "RAK",
    aircraft: "Boeing 737-800", // standard -> 60min lead, not a Dreamliner
    equipment_code: null,
    registration: null,
    callsign: null,
    terminal: "T1",
    scheduled_departure: "15:00",
    scheduled_arrival: null,
    gate: null,
    boarding_window_start: null,
    boarding_window_end: null,
    status: "scheduled",
    booking_pressure: "normal",
    day_of_week: "Monday",
    flight_date: "2026-09-21",
    week_start: TEST_WEEK_START,
    operator_type: "atlas_managed",
    destination_category: "Domestic",
    booked_passengers: null,
    seat_capacity: null,
    ...overrides,
  };
}

function makeRequirement(overrides: Partial<StaffingRequirement>): StaffingRequirement {
  return {
    id: "req-f1-boarding",
    flight_id: "f1",
    role: "Boarding",
    baseline_requirement: 1,
    additional_requirement: 0,
    total_requirement: 1,
    source: "fixed_rule",
    reasoning: "",
    needs_configuration: false,
    ...overrides,
  };
}

// 60-minute standard lead before a 15:00 departure -> window [14:00, 15:00].
// MT03 (05:45-14:45) does NOT fully cover it (ends before 15:00); NR01
// (08:00-17:00) and AP01 (13:45-22:45) both do.

describe("buildRemainingDutyGaps — baseline remaining Gate/Boarding/Profiling/Mesure demand before the top-up runs", () => {
  const requirements = [makeRequirement({})];
  const flights = [makeFlight({})];

  it("subtracts an already-committed employee holding the matching skill when their shift FULLY contains the requirement window", () => {
    const committed: GeneratedShiftAssignment[] = [{ employeeId: "e1", dayOfWeek: "Monday", shiftCode: "NR01", coversRoles: [] }]; // 08:00-17:00 fully contains 14:00-15:00
    const employees = [makeEmployee({ id: "e1" })];
    const gaps = buildRemainingDutyGaps(TEST_WEEK_START, "Monday", requirements, flights, committed, employees);
    expect(gaps).toEqual([{ role: "Boarding", windowStart: "14:00", windowEnd: "15:00", remaining: 0 }]);
  });

  it("does NOT credit a shift that only PARTIALLY overlaps the window (full-window coverage only)", () => {
    const committed: GeneratedShiftAssignment[] = [{ employeeId: "e1", dayOfWeek: "Monday", shiftCode: "MT03", coversRoles: [] }]; // 05:45-14:45 ends before 15:00 -- not full containment
    const employees = [makeEmployee({ id: "e1" })];
    const gaps = buildRemainingDutyGaps(TEST_WEEK_START, "Monday", requirements, flights, committed, employees);
    expect(gaps[0].remaining).toBe(1); // unchanged
  });

  it("never credits an employee who doesn't hold the matching skill, even with a fully-covering shift", () => {
    const committed: GeneratedShiftAssignment[] = [{ employeeId: "e1", dayOfWeek: "Monday", shiftCode: "NR01", coversRoles: [] }];
    const employees = [makeEmployee({ id: "e1", skills: ["Check-in"] })]; // no Boarding skill
    const gaps = buildRemainingDutyGaps(TEST_WEEK_START, "Monday", requirements, flights, committed, employees);
    expect(gaps[0].remaining).toBe(1); // unchanged
  });

  it("never goes negative, even with more covering capacity than required", () => {
    const twoHeadcountReqs = [makeRequirement({ total_requirement: 1 })];
    const committed: GeneratedShiftAssignment[] = [
      { employeeId: "e1", dayOfWeek: "Monday", shiftCode: "NR01", coversRoles: [] },
      { employeeId: "e2", dayOfWeek: "Monday", shiftCode: "NR01", coversRoles: [] },
    ];
    const employees = [makeEmployee({ id: "e1" }), makeEmployee({ id: "e2" })];
    const gaps = buildRemainingDutyGaps(TEST_WEEK_START, "Monday", twoHeadcountReqs, flights, committed, employees);
    expect(gaps[0].remaining).toBe(0); // floored at 0
  });

  it("ignores a requirement with no real headcount (e.g. a missing-operation-rule placeholder row)", () => {
    const placeholder = [makeRequirement({ role: "Staffing Rule", total_requirement: 0 })];
    const gaps = buildRemainingDutyGaps(TEST_WEEK_START, "Monday", placeholder, flights, [], []);
    expect(gaps).toEqual([]);
  });

  it("ignores a self-managed (company_config) requirement even if its role happens to collide with a RAM role name", () => {
    const companyReq = [makeRequirement({ source: "company_config" })];
    const gaps = buildRemainingDutyGaps(TEST_WEEK_START, "Monday", companyReq, flights, [], []);
    expect(gaps).toEqual([]);
  });
});

describe("computeEmployeeDayCountTopUp — RAM duty (Gate/Boarding/Profiling/Mesure) coverage bias", () => {
  const daysOrder = ["Monday"];

  it("with a real remaining duty gap only NR01/AP01 can fully close, prefers the covering code (NR01, list order) over shortest-first (MT03)", () => {
    const remainingByDay: Record<string, DutyWindowGap[]> = {
      Monday: [{ role: "Boarding", windowStart: "14:00", windowEnd: "15:00", remaining: 1 }],
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
      undefined, // t1Coverage
      undefined, // t1CoverageReasonsOut
      undefined, // t1DecrementedByDayOut
      { remainingByDay, employeeRoles: new Set(["Boarding"]) }
    );
    expect(additions.get("Monday")).toBe("NR01");
    expect(remainingByDay.Monday[0].remaining).toBe(0); // decremented as part of the real commit
  });

  it("an employee whose skills don't include the gap's role never gets the bias, even with a real gap supplied", () => {
    const remainingByDay: Record<string, DutyWindowGap[]> = {
      Monday: [{ role: "Boarding", windowStart: "14:00", windowEnd: "15:00", remaining: 1 }],
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
      undefined,
      undefined,
      undefined,
      { remainingByDay, employeeRoles: new Set(["Check-in"]) } // no Boarding role
    );
    expect(additions.get("Monday")).toBe("MT03"); // falls back to shortest-first
    expect(remainingByDay.Monday[0].remaining).toBe(1); // untouched
  });

  it("omitting dutyCoverage reproduces the exact prior (shortest-first) output -- full backward compatibility", () => {
    const additions = computeEmployeeDayCountTopUp("e1", daysOrder, TEST_WEEK_START, new Set(), 0, () => undefined, new Map(), 15, 1, 2, null);
    expect(additions.get("Monday")).toBe("MT03");
  });

  it("combines additively with the T1 bias: a code that closes BOTH a T1 gap and a duty gap outranks one closing only the duty gap", () => {
    // AP01 (13:45-22:45) and NR01 (08:00-17:00) both fully cover the duty
    // window (14:00-15:00). Only AP01 also fully covers the T1 window
    // (14:00-20:00) -- NR01 ends too early (17:00) for that one. So the
    // combined score should prefer AP01 even though, on duty score alone,
    // NR01 and AP01 would have tied.
    const remainingDutyByDay: Record<string, DutyWindowGap[]> = {
      Monday: [{ role: "Boarding", windowStart: "14:00", windowEnd: "15:00", remaining: 1 }],
    };
    const remainingT1ByDay = {
      Monday: [{ zone: "Main", windowStart: "14:00", windowEnd: "20:00", remaining: 1 }],
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
      { remainingByDay: remainingT1ByDay, employeeEligible: true },
      undefined,
      undefined,
      { remainingByDay: remainingDutyByDay, employeeRoles: new Set(["Boarding"]) }
    );
    expect(additions.get("Monday")).toBe("AP01");
  });
});

describe("generateObligationToppedUpShifts — cross-employee greedy duty coverage spreading", () => {
  const daysOrder = ["Monday", "Tuesday", "Wednesday"];

  it("the first matching-skill employee processed closes a real duty gap; the SECOND employee (same pass, same day) sees it already closed and falls back to the default pick", () => {
    const employees = [makeEmployee({ id: "e1" }), makeEmployee({ id: "e2" })];
    const remainingDutyGapsByDay: Record<string, DutyWindowGap[]> = {
      Monday: [{ role: "Boarding", windowStart: "14:00", windowEnd: "15:00", remaining: 1 }],
      Tuesday: [{ role: "Boarding", windowStart: "14:00", windowEnd: "15:00", remaining: 1 }],
      Wednesday: [{ role: "Boarding", windowStart: "14:00", windowEnd: "15:00", remaining: 1 }],
    };
    const result = generateObligationToppedUpShifts(
      daysOrder,
      employees,
      {},
      CONFIG,
      new Map(),
      15,
      TEST_WEEK_START,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined, // remainingT1ZoneGapsByDay
      remainingDutyGapsByDay
    );
    const workedDays = daysOrder.filter((d) => result[d].length > 0);
    expect(workedDays).toHaveLength(1);
    const workedDay = workedDays[0];
    const onDay = result[workedDay];
    const e1 = onDay.find((g) => g.employeeId === "e1")!;
    const e2 = onDay.find((g) => g.employeeId === "e2")!;
    expect(e1.shiftCode).toBe("NR01");
    expect(e1.dutyCoverageReason).toBeDefined();
    expect(e1.dutyCoverageReason).toContain("Boarding");
    expect(e2.shiftCode).toBe("MT03"); // gap already closed by e1
    expect(e2.dutyCoverageReason).toBeUndefined();
    expect(remainingDutyGapsByDay[workedDay][0].remaining).toBe(0);
  });

  it("an employee with no matching skill at all never benefits from the bias", () => {
    const employees = [makeEmployee({ id: "e1", skills: ["Check-in"] })];
    const remainingDutyGapsByDay: Record<string, DutyWindowGap[]> = {
      Monday: [{ role: "Boarding", windowStart: "14:00", windowEnd: "15:00", remaining: 1 }],
      Tuesday: [{ role: "Boarding", windowStart: "14:00", windowEnd: "15:00", remaining: 1 }],
      Wednesday: [{ role: "Boarding", windowStart: "14:00", windowEnd: "15:00", remaining: 1 }],
    };
    const result = generateObligationToppedUpShifts(
      daysOrder,
      employees,
      {},
      CONFIG,
      new Map(),
      15,
      TEST_WEEK_START,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      remainingDutyGapsByDay
    );
    const allAssignments = daysOrder.flatMap((d) => result[d]);
    expect(allAssignments).toHaveLength(1);
    expect(allAssignments[0].shiftCode).toBe("MT03"); // shortest-first default, bias never applied
    expect(allAssignments[0].dutyCoverageReason).toBeUndefined();
  });

  it("omitting remainingDutyGapsByDay reproduces the exact prior (shortest-first) output -- full backward compatibility", () => {
    const employees = [makeEmployee({ id: "e1" }), makeEmployee({ id: "e2" })];
    const result = generateObligationToppedUpShifts(daysOrder, employees, {}, CONFIG, new Map(), 15, TEST_WEEK_START);
    const allAssignments = daysOrder.flatMap((d) => result[d]);
    expect(allAssignments).toHaveLength(2);
    expect(allAssignments.every((g) => g.shiftCode === "MT03")).toBe(true);
    expect(allAssignments.every((g) => g.dutyCoverageReason === undefined)).toBe(true);
  });
});
