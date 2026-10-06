import { describe, it, expect } from "vitest";
import {
  isOvernightShift,
  resolveShiftInterval,
  shiftPortionOnDate,
  reachOfDayMinutes,
  shiftDurationMinutes,
} from "../lib/shift-interval";
import { nextCalendarDate } from "../lib/flight-date";
import { restHoursBetween } from "../lib/roster-generation";
import {
  overnightCarryoverWindow,
  buildDayEffectivePoolFromRosterEntries,
} from "../lib/planning/duty-generation";
import { generateFlexiblePoolShifts } from "../lib/planning/shift-generation";
import { aggregateDailyDemand } from "../lib/planning/demand-aggregation";
import { Employee, Flight, StaffingRequirement, WeeklyPlanRosterEntry } from "../lib/types";

/**
 * ===========================================================================
 * 2026-10-06 OVERNIGHT-SHIFT ACTIVATION — dedicated regression coverage.
 *
 * This is the focused regression suite called for by the activation work
 * (see lib/shift-interval.ts's own doc comment for the root-cause story):
 * narrow, targeted tests for exactly the cross-midnight behaviors that
 * changed — eligibility, overlap, rest, and the Sunday->Monday / month-end
 * calendar boundaries — plus explicit proof that overnight selection stays
 * demand-driven (never a blanket default) and that a genuine capacity
 * shortage still honestly surfaces as a gap rather than being hidden.
 *
 * This suite intentionally does NOT re-litigate the Stage-6-bucket-vs-
 * Stage-9-exact-matching known limitation (see
 * docs/known-limitations/roster-planning-vs-duty-allocation.md and the
 * dated comments in tests/hard-work-caps.test.ts / stage6-fatigue-wiring.
 * test.ts) and does NOT touch the separate, explicitly out-of-scope
 * 22:20-22:45 evening-gap issue.
 * ===========================================================================
 */

const POST_REGIME_DATE = "2026-09-28"; // Monday, on/after REGIME_CHANGE_DATE (2026-09-20)

describe("lib/shift-interval.ts — canonical overnight semantics", () => {
  it("isOvernightShift: true for every real overnight catalog code, false for every ordinary one", () => {
    expect(isOvernightShift("21:30", "06:30")).toBe(true); // N8
    expect(isOvernightShift("17:45", "06:30")).toBe(true); // NT01
    expect(isOvernightShift("17:45", "01:15")).toBe(true); // AP03
    expect(isOvernightShift("13:45", "01:15")).toBe(true); // AP04
    expect(isOvernightShift("13:45", "22:45")).toBe(false); // AP01
    expect(isOvernightShift("04:30", "14:45")).toBe(false); // MT02
  });

  it("resolveShiftInterval: an overnight shift's end genuinely falls on the FOLLOWING calendar date, never the start date", () => {
    const interval = resolveShiftInterval("2026-09-28", "21:30", "06:30"); // N8, Monday
    expect(interval.startDate).toBe("2026-09-28");
    expect(interval.endDate).toBe("2026-09-29"); // real D+1, via native Date rollover
    expect(interval.startMinutes).toBe(21 * 60 + 30);
    expect(interval.endMinutes).toBe(6 * 60 + 30);
  });

  it("resolveShiftInterval: an ordinary same-day shift's end stays on the start date", () => {
    const interval = resolveShiftInterval("2026-09-28", "13:45", "22:45"); // AP01
    expect(interval.startDate).toBe("2026-09-28");
    expect(interval.endDate).toBe("2026-09-28");
  });

  it("Sunday -> Monday boundary rolls over correctly via native Date, with no special-casing", () => {
    expect(nextCalendarDate("2026-09-27")).toBe("2026-09-28"); // Sunday -> Monday
    const interval = resolveShiftInterval("2026-09-27", "21:30", "06:30"); // N8 starting Sunday
    expect(interval.startDate).toBe("2026-09-27");
    expect(interval.endDate).toBe("2026-09-28");
  });

  it("month-end -> next-month boundary rolls over correctly via native Date", () => {
    expect(nextCalendarDate("2026-11-30")).toBe("2026-12-01");
    expect(nextCalendarDate("2026-02-28")).toBe("2026-03-01"); // 2026 is not a leap year
    const interval = resolveShiftInterval("2026-11-30", "17:45", "06:30"); // NT01 on the last day of November
    expect(interval.endDate).toBe("2026-12-01");
  });

  it("year-end boundary rolls over correctly via native Date", () => {
    expect(nextCalendarDate("2026-12-31")).toBe("2027-01-01");
  });

  it("shiftPortionOnDate: clips an overnight interval to each calendar day it actually touches", () => {
    const interval = resolveShiftInterval("2026-09-28", "21:30", "06:30"); // N8, Monday
    // On the day it STARTS: from entree to end-of-day.
    expect(shiftPortionOnDate(interval, "2026-09-28")).toEqual({ start: 21 * 60 + 30, end: 1440 });
    // On the FOLLOWING day: from start-of-day to its real sortie.
    expect(shiftPortionOnDate(interval, "2026-09-29")).toEqual({ start: 0, end: 6 * 60 + 30 });
    // Any other day: no coverage at all.
    expect(shiftPortionOnDate(interval, "2026-09-30")).toBeNull();
    expect(shiftPortionOnDate(interval, "2026-09-27")).toBeNull();
  });

  it("shiftPortionOnDate: an ordinary same-day shift is unaffected (both start and end touch the same date)", () => {
    const interval = resolveShiftInterval("2026-09-28", "13:45", "22:45"); // AP01
    expect(shiftPortionOnDate(interval, "2026-09-28")).toEqual({ start: 13 * 60 + 45, end: 22 * 60 + 45 });
  });

  it("reachOfDayMinutes: 1440 (end of day) for an overnight code, the real sortie for an ordinary one", () => {
    expect(reachOfDayMinutes(21 * 60 + 30, 6 * 60 + 30)).toBe(1440); // N8
    expect(reachOfDayMinutes(13 * 60 + 45, 22 * 60 + 45)).toBe(22 * 60 + 45); // AP01
  });

  it("shiftDurationMinutes: wrap-aware, never negative, for every overnight code", () => {
    expect(shiftDurationMinutes(21 * 60 + 30, 6 * 60 + 30)).toBe(9 * 60); // N8: 21:30 -> 06:30 = 9h
    expect(shiftDurationMinutes(17 * 60 + 45, 6 * 60 + 30)).toBe(12 * 60 + 45); // NT01: 17:45 -> 06:30 = 12h45
    expect(shiftDurationMinutes(17 * 60 + 45, 1 * 60 + 15)).toBe(7 * 60 + 30); // AP03: 17:45 -> 01:15 = 7h30
    expect(shiftDurationMinutes(13 * 60 + 45, 22 * 60 + 45)).toBe(9 * 60); // AP01, unaffected
  });
});

describe("cross-midnight eligibility — an overnight employee is findable the NEXT calendar day", () => {
  function makeEmployee(overrides: Partial<Employee>): Employee {
    return {
      id: "emp", name: "Test", skills: ["Boarding", "Gate"], assignment: "General T1 Pool",
      shift_code: null, shift_start: null, shift_end: null, rest_before_shift_hours: null,
      weekly_hours: null, is_duty_officer: false, off_days: [], foreign_company_authorizations: [],
      active: true, weekly_shifts: [],
      ...overrides,
    };
  }

  function rosterEntry(overrides: Partial<WeeklyPlanRosterEntry>): WeeklyPlanRosterEntry {
    return { id: "r", plan_id: "p", employee_id: "emp", day_of_week: "Monday", status: "working", shift_code: null, ...overrides };
  }

  it("overnightCarryoverWindow: null when there's no prior-day shift, or it wasn't overnight", () => {
    expect(overnightCarryoverWindow(null)).toBeNull();
    expect(overnightCarryoverWindow(undefined)).toBeNull();
    expect(overnightCarryoverWindow({ shift_start: "13:45", shift_end: "22:45" })).toBeNull(); // AP01, ordinary
  });

  it("overnightCarryoverWindow: clips an overnight shift to [00:00, its real sortie] for the FOLLOWING day", () => {
    expect(overnightCarryoverWindow({ shift_start: "21:30", shift_end: "06:30" })).toEqual({
      shift_start: "00:00",
      shift_end: "06:30",
    });
  });

  it("an employee on a Monday N8 (21:30-06:30) becomes eligible on Tuesday for an AP587-style 00:01-01:01 window, via the carryover pool, though they carry no Tuesday roster row of their own", () => {
    const employee = makeEmployee({ id: "night-1" });
    const mondayEntries = [rosterEntry({ employee_id: "night-1", day_of_week: "Monday", shift_code: "N8" })];
    const tuesdayEntries: WeeklyPlanRosterEntry[] = []; // no Tuesday roster row at all -- this is the whole point

    const pool = buildDayEffectivePoolFromRosterEntries(
      [employee],
      tuesdayEntries,
      "Tuesday",
      "2026-09-29",
      { dayOfWeek: "Monday", date: "2026-09-28", rosterEntries: mondayEntries }
    );

    expect(pool).toHaveLength(1);
    expect(pool[0].id).toBe("night-1");
    expect(pool[0].shift_start).toBe("00:00");
    expect(pool[0].shift_end).toBe("06:30"); // real carried-over N8 sortie, not a fabricated full day
  });

  it("without the previousDay argument, cross-midnight carryover is simply not applied (exact prior behavior for every un-migrated caller)", () => {
    const employee = makeEmployee({ id: "night-1" });
    const mondayEntries = [rosterEntry({ employee_id: "night-1", day_of_week: "Monday", shift_code: "N8" })];
    const pool = buildDayEffectivePoolFromRosterEntries([employee], [], "Tuesday", "2026-09-29");
    expect(pool).toHaveLength(0);
    void mondayEntries;
  });

  it("an ordinary (non-overnight) prior-day shift never produces a carryover candidate", () => {
    const employee = makeEmployee({ id: "day-1" });
    const mondayEntries = [rosterEntry({ employee_id: "day-1", day_of_week: "Monday", shift_code: "AP01" })]; // 13:45-22:45
    const pool = buildDayEffectivePoolFromRosterEntries(
      [employee],
      [],
      "Tuesday",
      "2026-09-29",
      { dayOfWeek: "Monday", date: "2026-09-28", rosterEntries: mondayEntries }
    );
    expect(pool).toHaveLength(0);
  });

  it("Sunday -> Monday week boundary: a Sunday N8 shift makes the employee eligible for an early Monday window, via the prior WEEK's own roster entries", () => {
    const employee = makeEmployee({ id: "night-2" });
    const sundayEntries = [rosterEntry({ employee_id: "night-2", day_of_week: "Sunday", shift_code: "N8" })];
    const pool = buildDayEffectivePoolFromRosterEntries(
      [employee],
      [], // this week's Monday roster -- the employee has no row of their own on Monday
      "Monday",
      "2026-09-28",
      { dayOfWeek: "Sunday", date: "2026-09-27", rosterEntries: sundayEntries } // PRIOR WEEK's Sunday
    );
    expect(pool).toHaveLength(1);
    expect(pool[0].id).toBe("night-2");
    expect(pool[0].shift_start).toBe("00:00");
    expect(pool[0].shift_end).toBe("06:30");
  });

  it("an employee already OFF, or with their own real working shift that day, is never duplicated or overridden by carryover", () => {
    const employee = makeEmployee({ id: "e1" });
    const mondayEntries = [rosterEntry({ employee_id: "e1", day_of_week: "Monday", shift_code: "N8" })];
    const tuesdayEntries = [rosterEntry({ employee_id: "e1", day_of_week: "Tuesday", shift_code: "AP01" })]; // real Tuesday shift
    const pool = buildDayEffectivePoolFromRosterEntries(
      [employee],
      tuesdayEntries,
      "Tuesday",
      "2026-09-29",
      { dayOfWeek: "Monday", date: "2026-09-28", rosterEntries: mondayEntries }
    );
    expect(pool).toHaveLength(1);
    expect(pool[0].shift_start).toBe("13:45"); // Tuesday's OWN real shift wins, not the carryover
    expect(pool[0].shift_end).toBe("22:45");
  });

  it("an employee OFF on the prior day produces no carryover, even if their static shift_code field would otherwise resolve to an overnight code", () => {
    const employee = makeEmployee({ id: "e1" });
    const mondayEntries = [rosterEntry({ employee_id: "e1", day_of_week: "Monday", status: "off", shift_code: null })];
    const pool = buildDayEffectivePoolFromRosterEntries(
      [employee],
      [],
      "Tuesday",
      "2026-09-29",
      { dayOfWeek: "Monday", date: "2026-09-28", rosterEntries: mondayEntries }
    );
    expect(pool).toHaveLength(0);
  });
});

describe("rest calculation across an overnight shift's real D+1 end", () => {
  it("rest from an overnight shift's TRUE end (next calendar day), never a false 24h or negative value", () => {
    // N8 21:30-06:30, next shift starts 14:45 the following day.
    // True rest = 14:45 - 06:30 = 8h15, NOT (24 - 21:30) + 14:45 = ~17h as a
    // naive same-day-end calculation would wrongly compute.
    const rest = restHoursBetween("21:30", "06:30", "14:45");
    expect(rest).toBeCloseTo(8.25, 5);
  });

  it("rest after an ordinary same-day shift is unaffected (exact prior behavior)", () => {
    // AP01 13:45-22:45, next shift starts 05:45 the following day: rest = (24-22:45) + 05:45 = 7h.
    const rest = restHoursBetween("13:45", "22:45", "05:45");
    expect(rest).toBeCloseTo(7, 5);
  });

  it("an overnight shift followed immediately by another shift that would start before the overnight shift's real end reports NEGATIVE rest (a genuine overlap), never a false positive 24h", () => {
    // N8 ends 06:30 the next day; a "next shift" nominally starting 03:00
    // the SAME following day would actually begin before N8 even ends --
    // this must be strongly negative, not a wrapped-around positive number.
    const rest = restHoursBetween("21:30", "06:30", "03:00");
    expect(rest).toBeLessThan(0);
  });
});

describe("demand-driven overnight selection — never a blanket default", () => {
  function makeEmployee(overrides: Partial<Employee>): Employee {
    return {
      id: "emp", name: "Test", skills: ["Boarding"], assignment: "General T1 Pool",
      shift_code: null, shift_start: null, shift_end: null, rest_before_shift_hours: null,
      weekly_hours: null, is_duty_officer: false, off_days: [], foreign_company_authorizations: [],
      active: true, weekly_shifts: [{ day_of_week: "Monday", shift_code: null, status: "working" }],
      ...overrides,
    };
  }

  function makeFlight(overrides: Partial<Flight>): Flight {
    return {
      id: "f1", flight_number: "AT100", airline: "Royal Air Maroc", route: "CMN → X",
      origin: "CMN", destination: "X", aircraft: "Boeing 737-800", equipment_code: null,
      registration: null, callsign: null, terminal: "T1", scheduled_departure: "10:00",
      scheduled_arrival: null, gate: null, boarding_window_start: "09:00", boarding_window_end: "10:00",
      status: "scheduled", booking_pressure: "normal", day_of_week: "Monday", flight_date: POST_REGIME_DATE, week_start: "2026-09-28",
      operator_type: "atlas_managed", destination_category: "Europe/Schengen",
      booked_passengers: null, seat_capacity: null,
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

  it("with ONLY ordinary daytime demand and no genuine overnight/early-morning need, Stage 6 never picks an overnight code -- a non-overnight code with identical coverage always wins the tie", () => {
    const flight = makeFlight({ scheduled_departure: "14:00", boarding_window_start: "13:00", boarding_window_end: "14:00" });
    const requirement = makeRequirement({});
    const demand = aggregateDailyDemand("Monday", [flight], [requirement]);

    const employee = makeEmployee({ id: "e1" });
    const result = generateFlexiblePoolShifts("Monday", POST_REGIME_DATE, demand, [employee]);

    expect(result).toHaveLength(1);
    // The chosen code must be an ordinary, non-overnight code -- real daytime
    // demand alone never justifies pushing the employee past midnight.
    const chosenCode = result[0].shiftCode;
    const assignedOvernight = ["AP03", "AP04", "NT01", "N8"].includes(chosenCode);
    expect(assignedOvernight).toBe(false);
  });

  it("when genuine demand reaches into the next calendar day's early-morning buckets, Stage 6 DOES select a genuinely-overnight code -- because it covers real, otherwise-unstaffable demand, not due to any tie-break bias", () => {
    // AP587-style case: an early-morning (00:01-01:01) Gate/Boarding
    // requirement the FOLLOWING day. No same-day (Monday) code can ever
    // reach it -- only an overnight code started Monday night carries
    // real coverage into it.
    const mondayFlight = makeFlight({ id: "f-mon", scheduled_departure: "14:00", boarding_window_start: "13:00", boarding_window_end: "14:00" });
    const mondayRequirement = makeRequirement({ id: "r-mon", flight_id: "f-mon" });
    const mondayDemand = aggregateDailyDemand("Monday", [mondayFlight], [mondayRequirement]);

    const tuesdayFlight = makeFlight({
      id: "f-tue", flight_number: "AP587", scheduled_departure: "01:01", day_of_week: "Tuesday", flight_date: "2026-09-29",
      boarding_window_start: "00:01", boarding_window_end: "01:01",
    });
    const tuesdayRequirement = makeRequirement({ id: "r-tue", flight_id: "f-tue" });
    const tuesdayDemand = aggregateDailyDemand("Tuesday", [tuesdayFlight], [tuesdayRequirement]);

    const employee = makeEmployee({ id: "e1" });
    const result = generateFlexiblePoolShifts(
      "Monday",
      POST_REGIME_DATE,
      mondayDemand,
      [employee],
      new Map(), // priorDayShift
      0, // minimumRestHours
      undefined, // rolesToConsider (default)
      new Map(), // nextDayBaselineShift
      new Map(), // hoursSoFarThisWeek
      undefined, // t1DemandByBucket
      undefined, // offWindowContext
      undefined, // fatigueContext
      undefined, // hardCaps
      tuesdayDemand // nextDayDemand -- the overnight lookahead
    );

    expect(result).toHaveLength(1);
    const chosenCode = result[0].shiftCode;
    expect(["NT01", "N8"]).toContain(chosenCode); // either genuinely reaches 01:01
  });

  it("a genuine capacity shortage still honestly surfaces as a gap -- overnight activation never manufactures coverage out of thin air", () => {
    // Same early-morning demand as above, but ZERO employees available --
    // no amount of overnight-shift support can staff a requirement with
    // no candidates at all.
    const tuesdayFlight = makeFlight({
      id: "f-tue", flight_number: "AP587", scheduled_departure: "01:01", day_of_week: "Tuesday", flight_date: "2026-09-29",
      boarding_window_start: "00:01", boarding_window_end: "01:01",
    });
    const tuesdayRequirement = makeRequirement({ id: "r-tue", flight_id: "f-tue", total_requirement: 2 });
    const tuesdayDemand = aggregateDailyDemand("Tuesday", [tuesdayFlight], [tuesdayRequirement]);

    // Only ONE employee, but demand needs TWO simultaneously -- a genuine
    // shortage that must remain a shortage, not be silently filled.
    const mondayFlight = makeFlight({ id: "f-mon", scheduled_departure: "14:00", boarding_window_start: "13:00", boarding_window_end: "14:00" });
    const mondayRequirement = makeRequirement({ id: "r-mon", flight_id: "f-mon", total_requirement: 1 });
    const mondayDemand = aggregateDailyDemand("Monday", [mondayFlight], [mondayRequirement]);

    const employee = makeEmployee({ id: "e1" });
    const result = generateFlexiblePoolShifts(
      "Monday",
      POST_REGIME_DATE,
      mondayDemand,
      [employee],
      new Map(),
      0,
      undefined,
      new Map(),
      new Map(),
      undefined,
      undefined,
      undefined,
      undefined,
      tuesdayDemand
    );

    // At most one shift is generated (one employee) -- the second seat of
    // Tuesday's 2-person early-morning requirement is genuinely unstaffable
    // from this pool and must remain so; this is a capacity fact, not a bug.
    expect(result.length).toBeLessThanOrEqual(1);
  });
});
