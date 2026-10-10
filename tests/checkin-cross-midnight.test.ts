import { describe, it, expect } from "vitest";
import {
  DEFAULT_ZONE_CHECKIN_DEMAND_POLICY,
  getFlightCheckinWindow,
  getFlightCheckinWindowUnclamped,
  flightCheckinSpilloverMinutesIntoPreviousDay,
} from "../lib/planning/checkin-zone-demand";
import { aggregateZoneDailyDemand, aggregateT1DemandProfileForDay, peakAggregateT1DemandMinuteForDay } from "../lib/planning/zone-demand-aggregation";
import {
  buildEligibleEmployeeAvailabilityForDay,
  buildDailyCapacityTimeline,
  buildZoneCoverageRowsForDay,
  EmployeeAvailabilityInput,
} from "../lib/planning/checkin-capacity-timeline";
import { buildPersistedWeeklyPlanView } from "../lib/planning/persisted-plan-view";
import { Employee, Flight, WeeklyPlanRosterEntry, WeeklyPlan } from "../lib/types";
import { CONFIG } from "../lib/seed-data";

/**
 * ===========================================================================
 * 2026-10-10 PHASE 1 — OVERNIGHT CONTINUITY CORRECTNESS, dedicated
 * regression coverage.
 *
 * Covers the two approved cross-midnight correctness fixes:
 *  1. Overnight-employee AVAILABILITY carryover into T1 Check-in
 *     (buildEligibleEmployeeAvailabilityForDay's new `previousDay` param,
 *     reusing duty-generation.ts's existing buildDayEffectivePoolFromRosterEntries
 *     mechanism — already covered end-to-end by
 *     tests/overnight-shift-activation.test.ts; this file adds the
 *     Check-in-module-specific wiring).
 *  2. Early-morning flight Check-in DEMAND reaching back into the previous
 *     calendar day (zone-demand-aggregation.ts's new `nextDayOfWeek` param
 *     on aggregateZoneDailyDemand/aggregateAllZonesDailyDemand, and
 *     checkin-capacity-timeline.ts's parallel instant-based logic).
 *
 * Both are additive/opt-in: every existing caller (and Stage 6's own T1
 * demand-bias input — aggregateT1DemandProfileForDay/
 * peakAggregateT1DemandMinuteForDay) must see byte-identical behavior.
 * ===========================================================================
 */

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

function rosterEntry(overrides: Partial<WeeklyPlanRosterEntry>): WeeklyPlanRosterEntry {
  return { id: "r", plan_id: "p", employee_id: "emp", day_of_week: "Monday", status: "working", shift_code: null, ...overrides };
}

function makeFlight(overrides: Partial<Flight>): Flight {
  return {
    id: "f1",
    flight_number: "AT1",
    airline: "Royal Air Maroc",
    route: "CMN-RAK",
    origin: "CMN",
    destination: "RAK", // Morocco -> t1_domestic
    aircraft: "737-800",
    equipment_code: null,
    registration: null,
    callsign: null,
    terminal: "T1",
    scheduled_departure: "02:00",
    scheduled_arrival: null,
    gate: null,
    boarding_window_start: null,
    boarding_window_end: null,
    status: "scheduled",
    booking_pressure: "normal",
    day_of_week: "Tuesday",
    flight_date: "2026-09-29",
    week_start: "2026-09-28",
    operator_type: "atlas_managed",
    destination_category: "domestic",
    ...overrides,
  } as Flight;
}

describe("checkin-zone-demand.ts — unclamped window / previous-day spillover primitives", () => {
  it("getFlightCheckinWindowUnclamped: a negative startMinutes means the window genuinely reaches back before midnight", () => {
    const earlyFlight = makeFlight({ scheduled_departure: "02:00" }); // opens 240min before = -02:00 the night before
    const unclamped = getFlightCheckinWindowUnclamped(earlyFlight, DEFAULT_ZONE_CHECKIN_DEMAND_POLICY);
    expect(unclamped).toEqual({ startMinutes: -120, endMinutes: 75 }); // 22:00 the day before -- 01:15 this day
  });

  it("getFlightCheckinWindow (the existing, clamped function) is UNCHANGED for the same flight", () => {
    const earlyFlight = makeFlight({ scheduled_departure: "02:00" });
    expect(getFlightCheckinWindow(earlyFlight, DEFAULT_ZONE_CHECKIN_DEMAND_POLICY)).toEqual({ start: "00:00", end: "01:15" });
  });

  it("flightCheckinSpilloverMinutesIntoPreviousDay + the flight's own clamped forward portion cover the full raw window exactly once -- they meet precisely at midnight, never overlapping, never leaving a gap", () => {
    const earlyFlight = makeFlight({ scheduled_departure: "02:00" });
    const spill = flightCheckinSpilloverMinutesIntoPreviousDay(earlyFlight, DEFAULT_ZONE_CHECKIN_DEMAND_POLICY)!;
    const forward = getFlightCheckinWindow(earlyFlight, DEFAULT_ZONE_CHECKIN_DEMAND_POLICY);
    expect(spill).toEqual({ startMinutes: 1320, endMinutes: 1440 }); // 22:00 -> 24:00 (midnight) on the PREVIOUS day's own clock
    expect(forward.start).toBe("00:00"); // the forward portion resumes exactly at midnight
    expect(forward.end).toBe("01:15");
  });

  it("returns null when a flight's window never reaches back past midnight (the ordinary case)", () => {
    const ordinaryFlight = makeFlight({ scheduled_departure: "08:30" }); // opens 04:30, well after midnight
    expect(flightCheckinSpilloverMinutesIntoPreviousDay(ordinaryFlight, DEFAULT_ZONE_CHECKIN_DEMAND_POLICY)).toBeNull();
  });

  it("a flight whose entire Check-in window falls before midnight produces a zero-length forward portion and a full spillover -- never double-counted, never silently dropped", () => {
    const veryEarlyFlight = makeFlight({ scheduled_departure: "00:10" }); // opens -03:50, closes -00:35 -- entirely before midnight
    const forward = getFlightCheckinWindow(veryEarlyFlight, DEFAULT_ZONE_CHECKIN_DEMAND_POLICY);
    expect(forward.start).toBe(forward.end); // zero-length -- no real forward-day demand
    const spill = flightCheckinSpilloverMinutesIntoPreviousDay(veryEarlyFlight, DEFAULT_ZONE_CHECKIN_DEMAND_POLICY)!;
    expect(spill.startMinutes).toBeLessThan(spill.endMinutes);
    expect(spill.endMinutes).toBeLessThanOrEqual(1440);
  });
});

describe("zone-demand-aggregation.ts — aggregateZoneDailyDemand's optional nextDayOfWeek (demand fix)", () => {
  it("without nextDayOfWeek, the previous day sees nothing (exact prior behavior)", () => {
    const earlyFlight = makeFlight({ id: "fearly", day_of_week: "Tuesday", scheduled_departure: "02:00" });
    const sundayUnfixed = aggregateZoneDailyDemand("Monday", "t1_domestic", [earlyFlight]);
    expect(sundayUnfixed.buckets.every((b) => b.required === 0)).toBe(true);
  });

  it("with nextDayOfWeek supplied, the previous day's own tail-end buckets correctly pick up the early flight's spillover demand", () => {
    const earlyFlight = makeFlight({ id: "fearly", day_of_week: "Tuesday", scheduled_departure: "02:00" });
    const mondayFixed = aggregateZoneDailyDemand("Monday", "t1_domestic", [earlyFlight], DEFAULT_ZONE_CHECKIN_DEMAND_POLICY, "Tuesday");
    const nonZero = mondayFixed.buckets.filter((b) => b.required > 0);
    expect(nonZero.map((b) => b.start)).toEqual(["22:00", "22:30", "23:00", "23:30"]);
    for (const b of nonZero) {
      expect(b.contributingFlightIds).toEqual(["fearly"]);
      expect(b.required).toBe(2); // zoneBaseAgents for t1_domestic
    }
  });

  it("the flight's own day (Tuesday) still sees exactly its ordinary, clamped forward portion -- unaffected by the previous day's opt-in", () => {
    const earlyFlight = makeFlight({ id: "fearly", day_of_week: "Tuesday", scheduled_departure: "02:00" });
    const tuesdayDemand = aggregateZoneDailyDemand("Tuesday", "t1_domestic", [earlyFlight]);
    const nonZero = tuesdayDemand.buckets.filter((b) => b.required > 0);
    expect(nonZero.map((b) => b.start)).toEqual(["00:00", "00:30", "01:00"]); // 00:00-01:15 forward portion, unchanged
  });

  it("REGRESSION: Stage 6's own T1 demand-bias input (aggregateT1DemandProfileForDay/peakAggregateT1DemandMinuteForDay) stays byte-identical even when a cross-midnight-eligible flight exists in the dataset -- neither function was given a nextDayOfWeek parameter at all", () => {
    const earlyFlight = makeFlight({ id: "fearly", day_of_week: "Tuesday", scheduled_departure: "02:00" });
    const profile = aggregateT1DemandProfileForDay("Monday", [earlyFlight], DEFAULT_ZONE_CHECKIN_DEMAND_POLICY);
    expect(profile.every((v) => v === 0)).toBe(true); // Monday has no flight of its own -- zero profile, exactly as before this fix existed
    const peak = peakAggregateT1DemandMinuteForDay("Monday", [earlyFlight], DEFAULT_ZONE_CHECKIN_DEMAND_POLICY);
    expect(peak).toBeNull();
  });

  it("no double-counting: the sum of Monday's spillover contribution and Tuesday's own forward contribution for this flight never exceeds what a single flight should contribute at any one instant", () => {
    const earlyFlight = makeFlight({ id: "fearly", day_of_week: "Tuesday", scheduled_departure: "02:00" });
    const mondayFixed = aggregateZoneDailyDemand("Monday", "t1_domestic", [earlyFlight], DEFAULT_ZONE_CHECKIN_DEMAND_POLICY, "Tuesday");
    const tuesdayDemand = aggregateZoneDailyDemand("Tuesday", "t1_domestic", [earlyFlight]);
    // Disjoint calendar-minute ranges by construction (Monday's spillover
    // buckets are >= 22:00, Tuesday's forward buckets are < 01:15) -- this
    // flight's id never appears in overlapping buckets of the two arrays.
    const mondayFlightBuckets = mondayFixed.buckets.filter((b) => b.contributingFlightIds.includes("fearly"));
    const tuesdayFlightBuckets = tuesdayDemand.buckets.filter((b) => b.contributingFlightIds.includes("fearly"));
    expect(mondayFlightBuckets.every((b) => b.start >= "22:00")).toBe(true);
    expect(tuesdayFlightBuckets.every((b) => b.start < "01:15")).toBe(true);
  });
});

describe("checkin-capacity-timeline.ts — buildEligibleEmployeeAvailabilityForDay's optional previousDay (capacity fix)", () => {
  it("without previousDay, an employee whose only shift was an overnight NT01 the day before is simply not found (exact prior behavior)", () => {
    const employee = makeEmployee({ id: "night-1" });
    const result = buildEligibleEmployeeAvailabilityForDay("Tuesday", [employee], [], [], [], [], undefined, "2026-09-29");
    expect(result).toHaveLength(0);
  });

  it("with previousDay supplied, an NT01 employee from the day before is found, available from 00:00 to their real carried-over sortie", () => {
    const employee = makeEmployee({ id: "night-1" });
    const mondayEntries = [rosterEntry({ employee_id: "night-1", day_of_week: "Monday", shift_code: "NT01" })];
    const result = buildEligibleEmployeeAvailabilityForDay(
      "Tuesday",
      [employee],
      [],
      [],
      [],
      [],
      undefined,
      "2026-09-29",
      { dayOfWeek: "Monday", date: "2026-09-28", rosterEntries: mondayEntries }
    );
    expect(result).toHaveLength(1);
    expect(result[0].employeeId).toBe("night-1");
    expect(result[0].shift).toEqual({ start: "00:00", end: "06:30" }); // real NT01 sortie under the regime effective 2026-09-28, not a fabricated full day
  });

  it("REGRESSION: another supported overnight code (AP03) carries over the same way", () => {
    const employee = makeEmployee({ id: "night-2" });
    const mondayEntries = [rosterEntry({ employee_id: "night-2", day_of_week: "Monday", shift_code: "AP03" })];
    const result = buildEligibleEmployeeAvailabilityForDay(
      "Tuesday",
      [employee],
      [],
      [],
      [],
      [],
      undefined,
      "2026-09-29",
      { dayOfWeek: "Monday", date: "2026-09-28", rosterEntries: mondayEntries }
    );
    expect(result).toHaveLength(1);
    expect(result[0].shift).toEqual({ start: "00:00", end: "01:15" }); // real AP03 sortie
  });

  it("an ordinary (non-overnight) prior-day shift never produces a carryover candidate here either -- reuses buildDayEffectivePoolFromRosterEntries' existing, already-tested rule unchanged", () => {
    const employee = makeEmployee({ id: "day-1" });
    const mondayEntries = [rosterEntry({ employee_id: "day-1", day_of_week: "Monday", shift_code: "AP01" })]; // 13:45-22:45, ordinary
    const result = buildEligibleEmployeeAvailabilityForDay(
      "Tuesday",
      [employee],
      [],
      [],
      [],
      [],
      undefined,
      "2026-09-29",
      { dayOfWeek: "Monday", date: "2026-09-28", rosterEntries: mondayEntries }
    );
    expect(result).toHaveLength(0);
  });

  it("PRESERVES committed duties: a carried-over overnight employee with an overlapping Gate/Boarding assignment on the new day keeps that busy window -- never assumed free just because the carryover makes them eligible", () => {
    const employee = makeEmployee({ id: "night-1" });
    const mondayEntries = [rosterEntry({ employee_id: "night-1", day_of_week: "Monday", shift_code: "NT01" })];
    const gateFlight = makeFlight({
      id: "fgate",
      day_of_week: "Tuesday",
      scheduled_departure: "01:30",
      destination: "LHR",
      destination_category: "UK/USA",
    });
    const requirement = {
      id: "req-gate",
      flight_id: "fgate",
      role: "Gate",
      baseline_requirement: 1,
      additional_requirement: 0,
      total_requirement: 1,
      source: "fixed_rule" as const,
      reasoning: "test",
      needs_configuration: false,
    };
    const assignment = {
      id: "a1",
      plan_id: "p",
      staffing_requirement_id: "req-gate",
      employee_id: "night-1",
      source: "atlas_generated" as const,
      created_at: new Date().toISOString(),
    };

    const result = buildEligibleEmployeeAvailabilityForDay(
      "Tuesday",
      [employee],
      [],
      [assignment as any],
      [requirement],
      [gateFlight],
      undefined,
      "2026-09-29",
      { dayOfWeek: "Monday", date: "2026-09-28", rosterEntries: mondayEntries }
    );

    expect(result).toHaveLength(1);
    // Gate requirement window: T-60min standard lead -> [00:30, 01:30) --
    // genuinely overlapping the carried-over 00:00-06:30 shift.
    expect(result[0].busyWindows).toContainEqual({ start: "00:30", end: "01:30" });
  });
});

describe("checkin-capacity-timeline.ts — combined demand+capacity cross-midnight regression (buildZoneCoverageRowsForDay)", () => {
  it("CAPACITY FIX ALONE closes part of an ordinary (non-cross-midnight) early-morning gap: an NT01 employee carried over from the day before becomes real coverage", () => {
    const employee = makeEmployee({ id: "night-1" });
    const mondayEntries = [rosterEntry({ employee_id: "night-1", day_of_week: "Monday", shift_code: "NT01" })];
    const ordinaryFlight = makeFlight({ id: "fA", day_of_week: "Tuesday", scheduled_departure: "04:00" }); // opens 00:00, closes 03:15 -- no midnight crossing on the demand side

    const withoutPrev = buildEligibleEmployeeAvailabilityForDay("Tuesday", [employee], [], [], [], [], undefined, "2026-09-29");
    const withPrev = buildEligibleEmployeeAvailabilityForDay(
      "Tuesday",
      [employee],
      [],
      [],
      [],
      [],
      undefined,
      "2026-09-29",
      { dayOfWeek: "Monday", date: "2026-09-28", rosterEntries: mondayEntries }
    );

    const rowsWithoutFix = buildZoneCoverageRowsForDay("Tuesday", [ordinaryFlight], withoutPrev);
    const rowsWithFix = buildZoneCoverageRowsForDay("Tuesday", [ordinaryFlight], withPrev);

    expect(rowsWithoutFix.t1_domestic[0].gap).toBe(2); // the genuine, previously-hidden-by-nothing shortfall
    expect(rowsWithFix.t1_domestic[0].available).toBe(1);
    expect(rowsWithFix.t1_domestic[0].gap).toBe(1); // real improvement, never fully fabricated away
  });

  it("DEMAND FIX ALONE surfaces a real early-morning requirement on the previous day's own tail end, which an ordinary same-day evening employee can then be matched against", () => {
    const eveningEmployee: EmployeeAvailabilityInput[] = [{ employeeId: "evening-1", shift: { start: "17:45", end: "23:59" }, busyWindows: [] }];
    const earlyTueFlight = makeFlight({ id: "fB", day_of_week: "Tuesday", scheduled_departure: "02:00" }); // spills into Monday 22:00-23:59

    const monWithoutFix = buildZoneCoverageRowsForDay("Monday", [earlyTueFlight], eveningEmployee);
    const monWithFix = buildZoneCoverageRowsForDay("Monday", [earlyTueFlight], eveningEmployee, DEFAULT_ZONE_CHECKIN_DEMAND_POLICY, "Tuesday");

    expect(monWithoutFix.t1_domestic).toHaveLength(0); // the real demand was entirely invisible before this fix
    expect(monWithFix.t1_domestic.length).toBeGreaterThan(0);
    const covered = monWithFix.t1_domestic.find((r) => r.start === "22:00")!;
    expect(covered.required).toBe(2);
    expect(covered.available).toBe(1);
    expect(covered.gap).toBe(1); // real, still-honest remaining shortfall (only one evening employee in this fixture)
  });

  it("REGRESSION: multi-zone split attribution still functions correctly when cross-midnight opt-in flights are present alongside ordinary same-day demand in two zones at once", () => {
    const mainFlight = makeFlight({ id: "fmain", day_of_week: "Wednesday", destination: "LHR", destination_category: "UK/USA", scheduled_departure: "10:00" });
    const domesticSpilloverFlight = makeFlight({ id: "fdom-spill", day_of_week: "Thursday", destination: "RAK", destination_category: "domestic", scheduled_departure: "02:00" });
    const employees: EmployeeAvailabilityInput[] = [
      { employeeId: "e1", shift: { start: "06:00", end: "23:59" }, busyWindows: [] },
      { employeeId: "e2", shift: { start: "06:00", end: "23:59" }, busyWindows: [] },
    ];

    const periods = buildDailyCapacityTimeline("Wednesday", [mainFlight, domesticSpilloverFlight], employees, DEFAULT_ZONE_CHECKIN_DEMAND_POLICY, "Thursday");
    // mainFlight's ordinary demand window (06:00-09:15, opens T-4h for a
    // 10:00 departure): Main sees real required/available there -- the
    // split-aware attribution from the 2026-09-23 fix is untouched by this
    // day also carrying an opt-in next-day spillover flight for a
    // DIFFERENT zone (t1_domestic, active only 22:00-23:59).
    const duringMainDemand = periods.find((p) => p.start === "06:00")!;
    expect(duringMainDemand.requiredByZone.t1_main_checkin).toBeGreaterThan(0);
    expect(duringMainDemand.availableByZone.t1_main_checkin ?? 0).toBeGreaterThan(0);

    // The spillover period itself: t1_domestic gets real required/available
    // from the next-day flight's backward spillover, correctly split from
    // Main's own (by-then-closed) demand -- both zones' attribution stays
    // correct simultaneously.
    const duringSpillover = periods.find((p) => p.start === "22:00")!;
    expect(duringSpillover.requiredByZone.t1_domestic).toBeGreaterThan(0);
    expect(duringSpillover.availableByZone.t1_domestic ?? 0).toBeGreaterThan(0);
    expect(duringSpillover.requiredByZone.t1_main_checkin ?? 0).toBe(0);
  });
});

describe("persisted-plan-view.ts — week-boundary wiring (first displayed day uses the previous calendar week's own roster)", () => {
  const DAYS_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const WEEK_START = "2026-09-28"; // Monday

  function makePlan(): WeeklyPlan {
    return {
      id: "plan-1",
      week_start: WEEK_START,
      week_label: "wk",
      status: "draft" as any,
      revision: 1,
      generated_at: new Date().toISOString(),
      published_at: null,
      generated_from_hash: "x",
      config_snapshot: CONFIG,
      issues: [],
      configuration_issues: [],
    };
  }

  it("without a previous-week roster, this week's Monday shows the genuine, uncovered gap", () => {
    const employee = makeEmployee({ id: "night-1" });
    const flightMondayEarly = makeFlight({ id: "fmon", day_of_week: "Monday", scheduled_departure: "04:00" });
    const view = buildPersistedWeeklyPlanView(makePlan(), [], [], [], [flightMondayEarly], [employee], DAYS_ORDER, [], []);
    const row = view.zoneCoverage.find((z) => z.dayOfWeek === "Monday" && z.zone === "t1_domestic")!;
    expect(row.available).toBe(0);
    expect(row.gap).toBe(2);
  });

  it("with the previous calendar week's own last-day (Sunday) NT01 roster supplied, this week's Monday correctly picks up the carryover", () => {
    const employee = makeEmployee({ id: "night-1" });
    const flightMondayEarly = makeFlight({ id: "fmon", day_of_week: "Monday", scheduled_departure: "04:00" });
    const priorWeekSundayEntries = [rosterEntry({ employee_id: "night-1", day_of_week: "Sunday", shift_code: "NT01" })];

    const view = buildPersistedWeeklyPlanView(
      makePlan(),
      [],
      [],
      [],
      [flightMondayEarly],
      [employee],
      DAYS_ORDER,
      [],
      [],
      priorWeekSundayEntries
    );
    const row = view.zoneCoverage.find((z) => z.dayOfWeek === "Monday" && z.zone === "t1_domestic")!;
    expect(row.available).toBe(1);
    expect(row.gap).toBe(1); // real improvement, not a fabricated full close
  });

  it("every OTHER day of the week is unaffected by whether a previous-week roster was supplied (the week-boundary fix is scoped to the first displayed day only)", () => {
    const employee = makeEmployee({ id: "night-1" });
    const flightTuesdayEarly = makeFlight({ id: "ftue", day_of_week: "Tuesday", scheduled_departure: "04:00" });
    const priorWeekSundayEntries = [rosterEntry({ employee_id: "night-1", day_of_week: "Sunday", shift_code: "NT01" })];

    const viewWithout = buildPersistedWeeklyPlanView(makePlan(), [], [], [], [flightTuesdayEarly], [employee], DAYS_ORDER, [], []);
    const viewWith = buildPersistedWeeklyPlanView(
      makePlan(),
      [],
      [],
      [],
      [flightTuesdayEarly],
      [employee],
      DAYS_ORDER,
      [],
      [],
      priorWeekSundayEntries
    );
    const rowWithout = viewWithout.zoneCoverage.find((z) => z.dayOfWeek === "Tuesday" && z.zone === "t1_domestic")!;
    const rowWith = viewWith.zoneCoverage.find((z) => z.dayOfWeek === "Tuesday" && z.zone === "t1_domestic")!;
    expect(rowWithout).toEqual(rowWith); // Tuesday never reads previousWeekLastDayRosterEntries -- only Monday (dayIndex 0) does
  });
});
