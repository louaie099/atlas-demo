import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  DEFAULT_HARD_WEEKLY_HOURS_CAP,
  DEFAULT_MAX_CONSECUTIVE_WORK_DAYS,
  resolveHardWorkCaps,
  nextConsecutiveWorkDayStreak,
  wouldExceedConsecutiveDayCap,
  wouldExceedHardWeeklyHoursCap,
  consecutiveRunLengthIfWorked,
  HardCapExclusion,
} from "../lib/planning/hard-work-caps";
import { deriveIncomingConsecutiveWorkDays, incomingStreakForHardCap, IncomingConsecutiveWorkDaysSeed } from "../lib/planning/consecutive-days-continuity";
import { generateDraftWeeklyPlan, DraftWeeklyPlan } from "../lib/planning/generate-draft-plan";
import { generateFlexiblePoolShifts } from "../lib/planning/shift-generation";
import { generateForeignCompanyShifts, generateProfilingMesureShifts } from "../lib/planning/specialized-team-generation";
import { selectCompatibleShiftCodes } from "../lib/foreign-shift-planning";
import { aggregateDailyDemand } from "../lib/planning/demand-aggregation";
import { buildDraftPlanBundle } from "../lib/planning/weekly-plan-service";
import { deriveFallbackBoundaryContext, previousWeekStart } from "../lib/planning/rotation-context";
import { isGenerationDrivenPopulation } from "../lib/planning/workforce-pools";
import { evaluateAverageWorkingHours } from "../lib/planning/average-hours";
import { auditAverageWeeklyHoursFeasibility, checkRestBetweenDays, checkRosterTargetShortfall } from "../lib/planning/validation";
import { computeCapAwareTargetWorkDays, shortestNonOvernightCodeHours } from "../lib/planning/roster-target";
import { repairSlotPopulationGaps, HARD_CAP_REPAIR_ATTEMPT_BUDGET, SlotRepairInput } from "../lib/planning/hard-cap-repair";
import { resolveDefaultLaborRules } from "../lib/labor-rules";
import { usesFixedCycleRotation } from "../lib/teams";
import { getShiftDurationHours } from "../lib/shift-templates";
import { flightDateFor } from "../lib/flight-date";
import { EMPLOYEES, FLIGHTS, CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_START, CURRENT_WEEK_LABEL } from "../lib/seed-data";
import { Config, Employee, Flight, StaffingRequirement, WeeklyPlanRosterEntry } from "../lib/types";

/**
 * HARD-CONSTRAINTS MILESTONE, PHASE 1 (2026-09-25): two new hard caps for
 * every generation-driven population — max 5 CONSECUTIVE calendar work days
 * and a hard single-displayed-week hours cap (Config.hard_weekly_hours_cap,
 * 42h by default, a NEW field deliberately separate from the 42h AVERAGE in
 * maximum_average_weekly_working_hours) — enforced as pre-scoring filters at
 * the SAME gates as the 15h rest rule. Requirement map (milestone brief §E):
 *   E1  no 6th consecutive work day, in every generation path, shortfall reported
 *   E2  never over hard_weekly_hours_cap in a displayed week
 *   E3  the caps compose with 15h rest as independent filters; a fully legal
 *       alternative candidate is still assigned
 *   E4  fixed-cycle employees byte-identical to before this phase
 *   E5  cross-week continuity (real predecessor streak / honest unknown)
 *   E6  maximum_average_weekly_working_hours & average-hours reporting untouched
 *   E7  caps set non-binding (999) = pre-phase output byte-for-byte
 * plus concrete PHASE-2 scenarios (avoidable gaps the naive filter creates).
 */

const WEEK = "2026-09-21"; // Monday, GMT regime
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const CAPS_OFF: Config = { ...CONFIG, hard_weekly_hours_cap: 999, max_consecutive_work_days: 999 };
const CONSECUTIVE_ONLY: Config = { ...CONFIG, hard_weekly_hours_cap: 999 };
const HOURS_ONLY: Config = { ...CONFIG, max_consecutive_work_days: 999 };

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "emp", name: "Test", skills: ["Boarding"], assignment: "General T1 Pool",
    // weekly_hours/rest_before_shift_hours are static display fields Stage 9
    // requires to be non-null for a rostered employee (scoring.ts).
    shift_code: null, shift_start: null, shift_end: null, rest_before_shift_hours: 24,
    weekly_hours: 30, is_duty_officer: false, off_days: [], foreign_company_authorizations: [],
    active: true, weekly_shifts: [],
    ...overrides,
  };
}

function makeFlight(overrides: Partial<Flight>): Flight {
  return {
    id: "f1", flight_number: "AT201", airline: "Royal Air Maroc", route: "CMN → CDG",
    origin: "CMN", destination: "CDG", aircraft: "Boeing 737-800", equipment_code: null,
    registration: null, callsign: null, terminal: "T1", scheduled_departure: "14:30",
    scheduled_arrival: null, gate: null, boarding_window_start: null, boarding_window_end: null,
    status: "scheduled", booking_pressure: "normal", day_of_week: "Monday", flight_date: WEEK, week_start: WEEK,
    operator_type: "atlas_managed", destination_category: "Europe/Schengen",
    booked_passengers: null, seat_capacity: null,
    ...overrides,
  };
}

/** One RAM 737-800 to CDG every day (Gate 1 + Boarding 1 + Profiling 1 each) and one Air France flight every day. */
function dailyFlights(): Flight[] {
  return DAYS.flatMap((day) => [
    makeFlight({ id: `ram-${day}`, day_of_week: day, flight_date: flightDateFor(WEEK, day) }),
    makeFlight({
      id: `af-${day}`, flight_number: "AF1397", airline: "Air France", route: "CMN → ORY", destination: "ORY",
      aircraft: "Airbus A319", scheduled_departure: "12:10", day_of_week: day, flight_date: flightDateFor(WEEK, day),
      operator_type: "self_managed",
    }),
  ]);
}

/** Two flexible ACEs (Gate+Boarding), one Profiling agent, a 3-person Air France team (headcount 3). */
function smallWorkforce(): Employee[] {
  return [
    makeEmployee({ id: "flex-a", name: "Flex A", skills: ["Gate", "Boarding"] }),
    makeEmployee({ id: "flex-b", name: "Flex B", skills: ["Gate", "Boarding"] }),
    makeEmployee({ id: "prof-1", name: "Prof One", skills: ["Profiling"], assignment: "Profiling" }),
    ...[1, 2, 3].map((i) => makeEmployee({ id: `af-${i}`, name: `AF ${i}`, assignment: "Air France", foreign_company_authorizations: ["Air France"] })),
  ];
}

function workPattern(plan: DraftWeeklyPlan, employeeId: string): boolean[] {
  return plan.daysOrder.map((day) => plan.rosterEntries.find((r) => r.employee_id === employeeId && r.day_of_week === day)?.status === "working");
}
function maxRun(worked: boolean[], incoming = 0): number {
  let s = incoming;
  let m = incoming;
  for (const w of worked) {
    s = w ? s + 1 : 0;
    m = Math.max(m, s);
  }
  return m;
}
function weekHours(plan: DraftWeeklyPlan, employeeId: string, weekStart: string): number {
  return plan.rosterEntries
    .filter((r) => r.employee_id === employeeId && r.status === "working" && r.shift_code)
    .reduce((sum, r) => sum + getShiftDurationHours(r.shift_code!, flightDateFor(weekStart, r.day_of_week)), 0);
}
function plan(config: Config, employees = smallWorkforce(), seeds?: ReadonlyMap<string, IncomingConsecutiveWorkDaysSeed>): DraftWeeklyPlan {
  return generateDraftWeeklyPlan(dailyFlights(), employees, [], config, DAYS, "W", WEEK, new Map(), "unknown", seeds ? { incomingConsecutiveWorkDays: seeds } : {});
}
function unfilledDays(p: DraftWeeklyPlan, role: string): string[] {
  const reqRole = new Map(p.requirements.map((r) => [r.id, r.role]));
  return [...new Set(p.issues.filter((i) => i.type === "unfilled_duty" && reqRole.get(i.requirementId!) === role).map((i) => i.dayOfWeek!))];
}
function blocking(p: DraftWeeklyPlan, team: string): { day: string; description: string }[] {
  return p.configurationIssues
    .filter((c) => c.requirementId.startsWith(`specialized-demand-conflict-${team}-`))
    .map((c) => ({ day: c.requirementId.slice(`specialized-demand-conflict-${team}-`.length), description: c.description }));
}

// ---------------------------------------------------------------------------

describe("config — the new hard hours cap is a SEPARATE field from the 42h average", () => {
  it("hard_weekly_hours_cap defaults to the same NUMBER as maximum_average_weekly_working_hours (42), from its own constant; max_consecutive_work_days defaults to 5", () => {
    expect(CONFIG.maximum_average_weekly_working_hours).toBe(42);
    expect(CONFIG.hard_weekly_hours_cap).toBe(CONFIG.maximum_average_weekly_working_hours);
    expect(DEFAULT_HARD_WEEKLY_HOURS_CAP).toBe(42);
    expect(CONFIG.max_consecutive_work_days).toBe(DEFAULT_MAX_CONSECUTIVE_WORK_DAYS);
    expect(DEFAULT_MAX_CONSECUTIVE_WORK_DAYS).toBe(5);
  });

  it("resolveHardWorkCaps reads the config, and falls back to the defaults for a pre-phase config_snapshot lacking both fields (never silently disabling a hard rule)", () => {
    expect(resolveHardWorkCaps(CONFIG)).toEqual({ maxConsecutiveWorkDays: 5, hardWeeklyHoursCap: 42 });
    expect(resolveHardWorkCaps({ hard_weekly_hours_cap: 40, max_consecutive_work_days: 4 })).toEqual({ maxConsecutiveWorkDays: 4, hardWeeklyHoursCap: 40 });
    const legacy = { ...CONFIG } as Partial<Config>;
    delete legacy.hard_weekly_hours_cap;
    delete legacy.max_consecutive_work_days;
    expect(resolveHardWorkCaps(legacy)).toEqual({ maxConsecutiveWorkDays: 5, hardWeeklyHoursCap: 42 });
  });
});

describe("pure primitives", () => {
  it("streak: +1 on a work day, reset to 0 on an OFF day", () => {
    expect(nextConsecutiveWorkDayStreak(0, true)).toBe(1);
    expect(nextConsecutiveWorkDayStreak(4, true)).toBe(5);
    expect(nextConsecutiveWorkDayStreak(5, false)).toBe(0);
  });

  it("wouldExceedConsecutiveDayCap: day 6 is refused, day 5 allowed, OFF never exceeds", () => {
    expect(wouldExceedConsecutiveDayCap(4, true, 5)).toBe(false);
    expect(wouldExceedConsecutiveDayCap(5, true, 5)).toBe(true);
    expect(wouldExceedConsecutiveDayCap(9, false, 5)).toBe(false);
  });

  it("wouldExceedHardWeeklyHoursCap: exactly reaching the cap is allowed, going over is refused", () => {
    expect(wouldExceedHardWeeklyHoursCap(33, 9, 42)).toBe(false);
    expect(wouldExceedHardWeeklyHoursCap(33.25, 9, 42)).toBe(true);
    expect(wouldExceedHardWeeklyHoursCap(33.25, 8.75, 42)).toBe(false);
    expect(wouldExceedHardWeeklyHoursCap(35, 8.75, 42)).toBe(true); // a 5th NR01 after 4 x 8.75h
  });

  it("consecutiveRunLengthIfWorked joins the runs on both sides and carries the incoming streak only for a run touching the window's first day", () => {
    const worked = [true, true, false, true, true, false, false];
    expect(consecutiveRunLengthIfWorked((k) => worked[k], 2, 7, 0)).toBe(5); // Mon Tue [Wed] Thu Fri
    expect(consecutiveRunLengthIfWorked((k) => worked[k], 2, 7, 3)).toBe(8); // + 3 carried in from last week
    expect(consecutiveRunLengthIfWorked((k) => worked[k], 5, 7, 3)).toBe(3); // Thu Fri [Sat] — not touching Monday
    expect(consecutiveRunLengthIfWorked((k) => worked[k], 6, 7, 3)).toBe(1); // Sunday never wraps onto this week's own Monday
  });
});

// ---------------------------------------------------------------------------

describe("E1 — no generation path ever assigns a 6th consecutive work day; the shortfall is reported honestly", () => {
  const off = plan(CAPS_OFF);
  const on = plan(CONSECUTIVE_ONLY);

  it("control: with the caps non-binding, demand alone pushes every path to 7 consecutive days", () => {
    expect(workPattern(off, "flex-a").filter(Boolean).length + workPattern(off, "flex-b").filter(Boolean).length).toBe(14);
    expect(maxRun(workPattern(off, "prof-1"))).toBe(7);
    for (const id of ["af-1", "af-2", "af-3"]) expect(maxRun(workPattern(off, id))).toBe(7);
    expect(unfilledDays(off, "Gate")).toEqual([]);
    expect(blocking(off, "Profiling")).toEqual([]);
    expect(blocking(off, "Air France")).toEqual([]);
  });

  // Saturday is the forced 6th day (Mon-Fri worked); the forced OFF resets
  // the streak, so Sunday is legal again.
  it("flexible pool (Stage 6 + top-up): Mon-Fri, forced OFF Saturday, Sunday again; Saturday's Gate & Boarding become honest unfilled_duty issues", () => {
    for (const id of ["flex-a", "flex-b"]) {
      expect(workPattern(on, id)).toEqual([true, true, true, true, true, false, true]);
    }
    expect(unfilledDays(on, "Gate")).toEqual(["Saturday"]);
    expect(unfilledDays(on, "Boarding")).toEqual(["Saturday"]);
    const excluded = on.hardCapExclusions.filter((x) => x.population === "flexible_pool");
    expect(excluded.map((x) => `${x.employeeId}|${x.dayOfWeek}|${x.reason}`).sort()).toEqual([
      "flex-a|Saturday|consecutive_work_days",
      "flex-b|Saturday|consecutive_work_days",
    ]);
  });

  it("Profiling/Mesure: capped at 5, Saturday reported as a BLOCKING demand conflict naming the cap", () => {
    expect(workPattern(on, "prof-1")).toEqual([true, true, true, true, true, false, true]);
    const conflicts = blocking(on, "Profiling");
    expect(conflicts.map((c) => c.day)).toEqual(["Saturday"]);
    for (const c of conflicts) {
      expect(c.description.startsWith("BLOCKING: ")).toBe(true);
      expect(c.description).toContain("Prof One (would be a 6th consecutive work day)");
      expect(c.description).toContain("phase 2");
    }
  });

  it("foreign company: capped at 5, Saturday reported as a BLOCKING demand conflict naming each excluded member", () => {
    for (const id of ["af-1", "af-2", "af-3"]) expect(workPattern(on, id)).toEqual([true, true, true, true, true, false, true]);
    const conflicts = blocking(on, "Air France");
    expect(conflicts.map((c) => c.day)).toEqual(["Saturday"]);
    for (const c of conflicts) {
      expect(c.description.startsWith("BLOCKING: ")).toBe(true);
      expect(c.description).toContain("3 otherwise rested, compatible team member(s) were excluded by a HARD cap");
    }
  });

  it("a conflict with NO cap involvement keeps its original wording byte-for-byte", () => {
    // Air France needs 3; a 2-person team is short every day for a non-cap reason.
    const team = smallWorkforce().filter((e) => e.id !== "af-3");
    const p = plan(CONSECUTIVE_ONLY, team);
    const monday = blocking(p, "Air France").find((c) => c.day === "Monday")!;
    const window = monday.description.match(/operation \((\d\d:\d\d–\d\d:\d\d)\)/)![1];
    expect(monday.description).toBe(
      `BLOCKING: Air France needed 3 staff member(s) for its Monday operation (${window}) but only 2 could be legally covered — no other team member was both rested (15h confirmed minimum) and held a compatible catalog shift for this window. The plan is intentionally incomplete here rather than persisting an illegal or fabricated assignment. Resolve with a workforce-design decision (headcount, or a confirmed shift-code policy for this team) — not something ATLAS can fix automatically.`
    );
  });
});

describe("E2 — never over hard_weekly_hours_cap for the displayed week", () => {
  it("every generation-driven employee stays <= 42h (they exceed it with the cap off), and the lost days surface as gaps/conflicts", () => {
    const off = plan(CAPS_OFF);
    const on = plan(HOURS_ONLY);
    for (const e of smallWorkforce()) {
      expect(weekHours(off, e.id, WEEK)).toBeGreaterThan(42);
      expect(weekHours(on, e.id, WEEK)).toBeLessThanOrEqual(42);
    }
    expect(unfilledDays(on, "Gate").length).toBeGreaterThan(0);
    expect(blocking(on, "Profiling").some((c) => c.description.includes("would exceed the 42h hard weekly hours cap"))).toBe(true);
    expect(blocking(on, "Air France").some((c) => c.description.includes("would exceed the 42h hard weekly hours cap"))).toBe(true);
  });

  it("the Stage-6.5 top-up never adds a day past the cap either — and (phase 2, part A) the resulting 4-day week is that employee's normal, cap-aware target, not a reported shortfall", () => {
    // Demand only on Monday -> the top-up must supply the other days.
    const flights = dailyFlights().filter((f) => f.day_of_week === "Monday" && f.operator_type === "atlas_managed");
    const p = generateDraftWeeklyPlan(flights, [makeEmployee({ id: "solo", skills: ["Boarding"] })], [], CONFIG, DAYS, "W", WEEK);
    expect(weekHours(p, "solo", WEEK)).toBeLessThanOrEqual(42);
    expect(workPattern(p, "solo").filter(Boolean).length).toBe(4); // 5 x 9h (shortest GMT code) = 45h > 42h
    // PHASE 2 (part A): phase 1 reported this as a "structural conflict"
    // top-up shortfall. The product owner resolved that a week the 42h cap
    // limits to 4 days IS the normal week — the top-up now aims at the
    // employee's own cap-aware target (4), reaches it, and reports nothing.
    expect(p.rosterTargets.find((t) => t.employeeId === "solo")).toMatchObject({ targetWorkDays: 4, normalTargetWorkDays: 5, capLimited: true });
    expect(p.configurationIssues.some((c) => c.requirementId === "hard-cap-roster-top-up-shortfall")).toBe(false);
    expect(p.issues.filter((i) => i.employeeId === "solo").map((i) => i.type)).toEqual([]);
  });
});

describe("E3 — the caps are independent filters composed with 15h rest at the same gate", () => {
  const flight = makeFlight({ day_of_week: "Wednesday", flight_date: "2026-09-23" });
  const req: StaffingRequirement = { id: "r1", flight_id: "ram-Wednesday", role: "Boarding", baseline_requirement: 1, additional_requirement: 0, total_requirement: 1, source: "fixed_rule", reasoning: "", needs_configuration: false };
  const demand = aggregateDailyDemand("Wednesday", [{ ...flight, id: "ram-Wednesday" }], [req]);
  const a = makeEmployee({ id: "a-first", skills: ["Boarding"] });
  const b = makeEmployee({ id: "b-second", skills: ["Boarding"] });
  const caps = resolveHardWorkCaps(CONFIG);
  const run = (employees: Employee[], streaks: [string, number][], hours: [string, number][], prior: [string, { shift_start: string; shift_end: string } | null][] = []) => {
    const exclusionsOut: HardCapExclusion[] = [];
    const result = generateFlexiblePoolShifts("Wednesday", "2026-09-23", demand, employees, new Map(prior), 15, undefined, new Map(), new Map(hours), undefined, undefined, undefined, {
      caps,
      streakEnteringDay: new Map(streaks),
      exclusionsOut,
    });
    return { ids: result.map((g) => g.employeeId), exclusionsOut };
  };

  it("rest-legal but on day 6 -> excluded; the fully-legal alternative is assigned (without the cap the excluded one would have won the id tie-break)", () => {
    expect(generateFlexiblePoolShifts("Wednesday", "2026-09-23", demand, [a, b]).map((g) => g.employeeId)).toEqual(["a-first"]);
    const { ids, exclusionsOut } = run([a, b], [["a-first", 5], ["b-second", 1]], []);
    expect(ids).toEqual(["b-second"]);
    expect(exclusionsOut).toEqual([{ employeeId: "a-first", dayOfWeek: "Wednesday", population: "flexible_pool", reason: "consecutive_work_days" }]);
    expect(run([a], [["a-first", 5]], []).ids).toEqual([]); // alone: an honest gap, never an assignment
  });

  it("rest-legal AND under the consecutive cap but over hours -> excluded; the fully-legal alternative is assigned", () => {
    const { ids, exclusionsOut } = run([a, b], [["a-first", 2], ["b-second", 2]], [["a-first", 38], ["b-second", 20]]);
    expect(ids).toEqual(["b-second"]);
    expect(exclusionsOut).toEqual([{ employeeId: "a-first", dayOfWeek: "Wednesday", population: "flexible_pool", reason: "hard_weekly_hours" }]);
    expect(run([a], [["a-first", 2]], [["a-first", 38]]).ids).toEqual([]);
    // Without hardCaps the same 38h employee is still assignable (the soft hours tie-break alone never excludes).
    expect(generateFlexiblePoolShifts("Wednesday", "2026-09-23", demand, [a], new Map(), 15, undefined, new Map(), new Map([["a-first", 38]])).map((g) => g.employeeId)).toEqual(["a-first"]);
  });

  it("rest is still enforced exactly as before, independently: a rest-illegal candidate is excluded even when both caps are fine (and is not misreported as a cap exclusion)", () => {
    // Prior-day shift ending 06:30 the same morning (overnight NT01) leaves < 15h before any shift covering 14:30.
    const { ids, exclusionsOut } = run([a, b], [["a-first", 0], ["b-second", 0]], [], [["a-first", { shift_start: "17:45", shift_end: "06:30" }]]);
    expect(ids).toEqual(["b-second"]);
    expect(exclusionsOut).toEqual([]);
  });

  it("selectCompatibleShiftCodes applies both caps in its filter step: day 6 -> nothing; hours -> only the codes that still fit", () => {
    const base = { consecutiveWorkDaysBeforeToday: 0, maxConsecutiveWorkDays: 5, hoursSoFarThisWeek: 0, hardWeeklyHoursCap: 42 };
    const all = selectCompatibleShiftCodes("13:00", "14:00", null, null, 15, true, false, "2026-09-23");
    expect(all.length).toBeGreaterThan(1);
    expect(selectCompatibleShiftCodes("13:00", "14:00", null, null, 15, true, false, "2026-09-23", base)).toEqual(all);
    expect(selectCompatibleShiftCodes("13:00", "14:00", null, null, 15, true, false, "2026-09-23", { ...base, consecutiveWorkDaysBeforeToday: 5 })).toEqual([]);
    const fitting = selectCompatibleShiftCodes("13:00", "14:00", null, null, 15, true, false, "2026-09-23", { ...base, hoursSoFarThisWeek: 33 });
    expect(fitting.length).toBeGreaterThan(0);
    expect(fitting.length).toBeLessThan(all.length);
    for (const c of fitting) expect(getShiftDurationHours(c.code, "2026-09-23")).toBeLessThanOrEqual(9);
  });
});

// ---------------------------------------------------------------------------

describe("E5 — cross-week continuity of the consecutive-work-day count", () => {
  const priorWeek = previousWeekStart(WEEK);
  const rosterRow = (employeeId: string, day: string, code: string | null): WeeklyPlanRosterEntry => ({
    id: `r-${employeeId}-${day}`, plan_id: "prior", employee_id: employeeId, day_of_week: day, status: code ? "working" : "off", shift_code: code,
  });
  const workedFriSatSun = (id: string) => DAYS.map((d) => rosterRow(id, d, ["Friday", "Saturday", "Sunday"].includes(d) ? "NR01" : null));

  it("deriveIncomingConsecutiveWorkDays: real predecessor -> exact streak (lower bound if the whole week was worked); absent row / no context / demand-driven fallback -> explicit unknown; static fallback -> approximate", () => {
    const prof = makeEmployee({ id: "prof-1", assignment: "Profiling", skills: ["Profiling"] });
    const input = { kind: "prior_plan" as const, priorPlanRosterEntries: workedFriSatSun("prof-1"), weekStart: WEEK, daysOrder: DAYS };
    expect(deriveIncomingConsecutiveWorkDays(prof, input)).toEqual({ source: "prior_plan", streak: 3, lowerBound: false });
    const allWeek = DAYS.map((d) => rosterRow("prof-1", d, "NR01"));
    expect(deriveIncomingConsecutiveWorkDays(prof, { ...input, priorPlanRosterEntries: allWeek })).toEqual({ source: "prior_plan", streak: 7, lowerBound: true });
    expect(deriveIncomingConsecutiveWorkDays(makeEmployee({ id: "nobody" }), input).source).toBe("unknown");
    expect(deriveIncomingConsecutiveWorkDays(prof, { kind: "none" })).toMatchObject({ source: "unknown", streak: null });
    expect(deriveIncomingConsecutiveWorkDays(prof, { kind: "fallback_static_baseline", weekStart: WEEK, daysOrder: DAYS })).toMatchObject({ source: "unknown", streak: null });
    const transit = EMPLOYEES.find((e) => usesFixedCycleRotation(e.assignment))!;
    const fallback = deriveIncomingConsecutiveWorkDays(transit, { kind: "fallback_static_baseline", weekStart: CURRENT_WEEK_START, daysOrder: DAYS_WITH_DATA });
    expect(fallback).toMatchObject({ source: "fallback_static_baseline", approximate: true });
    expect(incomingStreakForHardCap(undefined)).toEqual({ streak: 0, known: false });
    expect(incomingStreakForHardCap({ source: "unknown", streak: null, reason: "x" })).toEqual({ streak: 0, known: false });
    expect(incomingStreakForHardCap({ source: "prior_plan", streak: 3, lowerBound: false })).toEqual({ streak: 3, known: true });
  });

  it("a real predecessor showing day 3 of a streak allows only 2 more days (Mon, Tue) before the cap — in the flexible, Profiling and foreign paths — not a fresh 5", () => {
    const employees = smallWorkforce();
    const prior = employees.flatMap((e) => workedFriSatSun(e.id));
    const input = { kind: "prior_plan" as const, priorPlanRosterEntries: prior, weekStart: WEEK, daysOrder: DAYS };
    const seeds = new Map(employees.map((e) => [e.id, deriveIncomingConsecutiveWorkDays(e, input)]));
    const p = plan(CONSECUTIVE_ONLY, employees, seeds);
    for (const e of employees) {
      const worked = workPattern(p, e.id);
      expect(worked.slice(0, 3), e.id).toEqual([true, true, false]); // Mon, Tue, then OFF Wednesday (would be day 6)
      expect(maxRun(worked, 3), e.id).toBeLessThanOrEqual(5);
    }
    expect(unfilledDays(p, "Gate")).toContain("Wednesday");
    expect(blocking(p, "Profiling").map((c) => c.day)).toContain("Wednesday");
    expect(blocking(p, "Air France").map((c) => c.day)).toContain("Wednesday");
    expect(p.issues.some((i) => i.type === "consecutive_work_history_unknown")).toBe(false); // history was real
  });

  it("through the production service (buildDraftPlanBundle + priorPlanRosterEntries): the same real streak is honored", () => {
    const employees = smallWorkforce();
    const bundle = buildDraftPlanBundle({
      planId: "p", weekStart: WEEK, weekLabel: "W", revision: 1, flights: dailyFlights(), employees, config: CONSECUTIVE_ONLY, daysOrder: DAYS,
      priorWeekBoundaryContext: new Map(employees.map((e) => [e.id, { shift_start: "08:00", shift_end: "17:00" }])),
      priorPlanRosterEntries: employees.flatMap((e) => workedFriSatSun(e.id)),
    });
    const wed = bundle.rosterEntries.filter((r) => r.day_of_week === "Wednesday");
    expect(wed.every((r) => r.status === "off")).toBe(true);
    expect(bundle.plan.issues.some((i) => i.type === "consecutive_work_history_unknown")).toBe(false);
  });

  it("a MISSING predecessor is the documented 'unknown' policy: the count starts at 0 (5 days allowed) AND the plan carries a visible, non-blocking note — never a silent 'definitely day 0'", () => {
    const p = plan(CONSECUTIVE_ONLY); // no seeds at all
    expect(maxRun(workPattern(p, "prof-1"))).toBe(5);
    expect(workPattern(p, "prof-1").slice(0, 5)).toEqual([true, true, true, true, true]);
    const notes = p.issues.filter((i) => i.type === "consecutive_work_history_unknown");
    expect(notes).toHaveLength(1);
    expect(notes[0].description).toContain("unknown for 6 generation-driven employee(s)");
    expect(notes[0].description).toContain("counts their streak from 0");
    // Same through the service with no predecessor (static fallback = unknown for demand-driven staff).
    const bundle = buildDraftPlanBundle({ planId: "p", weekStart: WEEK, weekLabel: "W", revision: 1, flights: dailyFlights(), employees: smallWorkforce(), config: CONSECUTIVE_ONLY, daysOrder: DAYS });
    expect(bundle.plan.issues.filter((i) => i.type === "consecutive_work_history_unknown")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("whole demo plan (real seed data) — E4 / E6 / E7 and the default-config invariants", () => {
  const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures", "pre-hard-caps-demo-plan.json"), "utf8")) as { weekStart: string; roster: Record<string, string>; duties: string[] };
  const boundary = deriveFallbackBoundaryContext(EMPLOYEES, DAYS_WITH_DATA, CURRENT_WEEK_START);
  const demo = (config: Config) => generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], config, DAYS_WITH_DATA, CURRENT_WEEK_LABEL, CURRENT_WEEK_START, boundary, "fallback_static_baseline");
  const rosterOf = (p: DraftWeeklyPlan): Record<string, string> =>
    Object.fromEntries(
      EMPLOYEES.map((e) => [
        e.id,
        DAYS_WITH_DATA.map((day) => {
          const r = p.rosterEntries.find((x) => x.employee_id === e.id && x.day_of_week === day)!;
          return r.status === "working" ? r.shift_code : "OFF";
        }).join("|"),
      ])
    );
  const dutiesOf = (p: DraftWeeklyPlan) => DAYS_WITH_DATA.flatMap((day) => p.dutiesByDay[day].map((d) => `${day}|${d.requirementId}|${d.employeeId}`));
  const atDefault = demo(CONFIG);
  const defaultRoster = rosterOf(atDefault);

  it("E7 — with both caps non-binding (999h / 999 days) the demo roster AND every duty are byte-identical to the pre-phase output", () => {
    const p = demo(CAPS_OFF);
    expect(rosterOf(p)).toEqual(fixture.roster);
    expect(dutiesOf(p)).toEqual(fixture.duties);
    expect(p.hardCapExclusions).toEqual([]);
  });

  it("E4 — every fixed-cycle employee (Transit/Leaders/Duty Officers) has a byte-identical roster at the DEFAULT caps", () => {
    const fixed = EMPLOYEES.filter((e) => usesFixedCycleRotation(e.assignment));
    expect(fixed.length).toBeGreaterThan(0);
    for (const e of fixed) expect(defaultRoster[e.id], e.id).toBe(fixture.roster[e.id]);
    // ...and so does every other non-generation-driven (static) employee.
    for (const e of EMPLOYEES.filter((x) => !isGenerationDrivenPopulation(x))) expect(defaultRoster[e.id], e.id).toBe(fixture.roster[e.id]);
    expect(atDefault.hardCapExclusions.some((x) => usesFixedCycleRotation(EMPLOYEES.find((e) => e.id === x.employeeId)!.assignment))).toBe(false);
  });

  it("default caps: no generation-driven employee exceeds 5 consecutive days or 42h (youssef-el-amrani's documented 7-day/63h week is now capped), and 15h rest still holds", () => {
    expect(fixture.roster["youssef-el-amrani"]).toBe("MT01|MT01|MT01|MT01|MT01|MT01|MT01");
    for (const e of EMPLOYEES.filter(isGenerationDrivenPopulation)) {
      const worked = defaultRoster[e.id].split("|").map((c) => c !== "OFF");
      expect(maxRun(worked), e.id).toBeLessThanOrEqual(5);
      expect(weekHours(atDefault, e.id, CURRENT_WEEK_START), e.id).toBeLessThanOrEqual(42);
    }
    expect(atDefault.issues.filter((i) => i.type === "rest_violation")).toEqual([]);
    expect(maxRun(defaultRoster["youssef-el-amrani"].split("|").map((c) => c !== "OFF"))).toBeLessThanOrEqual(4);
  });

  it("E6 — maximum_average_weekly_working_hours is untouched: still the resolved 42h AVERAGE, still not evaluable, still no findings — and generation never reads it", () => {
    const rules = resolveDefaultLaborRules();
    expect(CONFIG.maximum_average_weekly_working_hours).toBe(rules.maximumAverageWeeklyWorkingHours);
    expect(CONFIG.working_hours_reference_period_days).toBeNull();
    expect(evaluateAverageWorkingHours(63, 7, CONFIG)).toEqual({ status: "not_evaluable", reason: "reference_period_unconfigured" });
    // The hard cap never feeds average-hours reporting...
    expect(evaluateAverageWorkingHours(63, 7, { ...CONFIG, hard_weekly_hours_cap: 1 })).toEqual(evaluateAverageWorkingHours(63, 7, CONFIG));
    const withRef = { ...CONFIG, working_hours_reference_period_days: 7 };
    expect(evaluateAverageWorkingHours(63, 7, { ...withRef, hard_weekly_hours_cap: 999 })).toEqual(evaluateAverageWorkingHours(63, 7, withRef));
    expect(auditAverageWeeklyHoursFeasibility(EMPLOYEES, isGenerationDrivenPopulation, CONFIG, CURRENT_WEEK_START)).toEqual([]);
    // ...and generation never reads the average: moving it changes nothing.
    expect(rosterOf(demo({ ...CONFIG, maximum_average_weekly_working_hours: 10 }))).toEqual(defaultRoster);
    expect(rosterOf(demo({ ...CONFIG, maximum_average_weekly_working_hours: 99 }))).toEqual(defaultRoster);
  });

  it("default caps on the demo: no NEW unfilled flight duty and no new rest violation versus the pre-phase plan (the cost shows up as fewer rostered days, reported below)", () => {
    expect(dutiesOf(atDefault).length).toBe(fixture.duties.length);
    expect(atDefault.issues.filter((i) => i.type === "unfilled_duty")).toEqual([]);
    // PHASE 2 (part A): the cost still shows up as fewer rostered days, but
    // every such week now meets its own cap-aware target, so the phase-1
    // top-up-shortfall note (which counted the unreachable fixed 5) is gone
    // and no employee gets a roster_target_shortfall.
    expect(atDefault.rosterTargets.some((t) => t.capLimited)).toBe(true);
    expect(atDefault.configurationIssues.some((c) => c.requirementId === "hard-cap-roster-top-up-shortfall")).toBe(false);
    expect(atDefault.issues.filter((i) => i.type === "roster_target_shortfall")).toEqual([]);
    for (const e of EMPLOYEES.filter(isGenerationDrivenPopulation)) {
      const asEmployee = { ...e, weekly_shifts: DAYS_WITH_DATA.map((day, i) => { const c = defaultRoster[e.id].split("|")[i]; return { day_of_week: day, status: c === "OFF" ? ("off" as const) : ("working" as const), shift_code: c === "OFF" ? null : c }; }) };
      const hard = checkRestBetweenDays(asEmployee, DAYS_WITH_DATA, CONFIG, CURRENT_WEEK_START).filter((i) => i.type === "rest_violation");
      expect(hard, e.id).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------


// ===========================================================================
// PHASE 2 (2026-09-25): part A — cap-aware per-employee roster target;
// part B — the bounded cross-employee hard-cap repair pass.
// ===========================================================================

/** Air France's pinned phase-1 fixture: 5 members, headcount 3 every day, af-1..af-3 arriving on day 4 of a real streak. */
function airFranceScenario(config: Config, repair = true) {
  const team = [1, 2, 3, 4, 5].map((i) => makeEmployee({ id: `af-${i}`, name: `AF ${i}`, assignment: "Air France", foreign_company_authorizations: ["Air France"] }));
  const flights = dailyFlights().filter((f) => f.airline === "Air France");
  const incoming = new Map([["af-1", 4], ["af-2", 4], ["af-3", 4], ["af-4", 0], ["af-5", 0]]);
  const repairsOut: import("../lib/planning/hard-cap-repair").HardCapRepair[] = [];
  const result = generateForeignCompanyShifts(DAYS, team, flights, ["Air France"], 15, WEEK, new Map(), undefined, undefined, {
    caps: resolveHardWorkCaps(config),
    incomingStreakByEmployee: incoming,
    repairsOut,
    repair,
  });
  const pattern = (id: string) => DAYS.map((d) => result.generatedShiftsByDay[d].find((g) => g.employeeId === id)?.shiftCode ?? null);
  return { team, incoming, result, repairsOut, pattern };
}

/** Profiling's pinned phase-1 fixture: Monday needs 1, Tuesday needs 2; p-tired arrives on day 4. */
function profilingScenario(repair = true) {
  const pool = [makeEmployee({ id: "p-tired", name: "P Tired", assignment: "Profiling", skills: ["Profiling"] }), makeEmployee({ id: "p-fresh", name: "P Fresh", assignment: "Profiling", skills: ["Profiling"] })];
  const flights = dailyFlights().filter((f) => f.operator_type === "atlas_managed" && (f.day_of_week === "Monday" || f.day_of_week === "Tuesday"));
  const reqs: StaffingRequirement[] = flights.map((f) => ({
    id: `r-${f.day_of_week}`, flight_id: f.id, role: "Profiling", baseline_requirement: 1, additional_requirement: 0,
    total_requirement: f.day_of_week === "Tuesday" ? 2 : 1, source: "fixed_rule", reasoning: "", needs_configuration: false,
  }));
  const demandByDay = Object.fromEntries(DAYS.map((d) => [d, aggregateDailyDemand(d, flights, reqs)]));
  const incoming = new Map([["p-tired", 4], ["p-fresh", 0]]);
  const repairsOut: import("../lib/planning/hard-cap-repair").HardCapRepair[] = [];
  const result = generateProfilingMesureShifts(DAYS, pool, demandByDay, 15, WEEK, new Map(), { caps: resolveHardWorkCaps(CONFIG), incomingStreakByEmployee: incoming, repairsOut, repair });
  return { pool, incoming, result, repairsOut };
}

function patternHoursOf(pattern: (string | null)[], weekStart: string): number {
  return pattern.reduce((sum, code, i) => sum + (code ? getShiftDurationHours(code, flightDateFor(weekStart, DAYS[i])) : 0), 0);
}

describe("PHASE 2, part A — cap-aware per-employee roster target (a 4-day week forced by the 42h cap is normal; a week short of its own target is still flagged)", () => {
  it("computeCapAwareTargetWorkDays: from REAL date-resolved code durations — 4 at 42h (5 x 9h = 45h), 5 when the cap is not binding, fewer when committed demand codes are long", () => {
    // GMT regime: the shortest non-overnight code is 9h; the legacy regime's is 8.75h (NR01).
    expect(shortestNonOvernightCodeHours("2026-09-23")).toBe(9);
    expect(shortestNonOvernightCodeHours("2026-09-02")).toBe(8.75);
    const base = { daysOrder: DAYS, weekStart: WEEK, normalTargetWorkDays: 5 };
    expect(computeCapAwareTargetWorkDays({ ...base, hardWeeklyHoursCap: 42 })).toMatchObject({ targetWorkDays: 4, capLimited: true, assumedFreeDayHours: [9, 9, 9, 9] });
    expect(computeCapAwareTargetWorkDays({ ...base, hardWeeklyHoursCap: 999 })).toMatchObject({ targetWorkDays: 5, capLimited: false });
    expect(computeCapAwareTargetWorkDays({ ...base, hardWeeklyHoursCap: 45 })).toMatchObject({ targetWorkDays: 5, capLimited: false }); // 5 x 9h fits exactly
    // Legacy regime (8.75h): 4 x 8.75 = 35 fits, a 5th (43.75h) does not.
    expect(computeCapAwareTargetWorkDays({ ...base, weekStart: "2026-08-31", hardWeeklyHoursCap: 42 }).targetWorkDays).toBe(4);
    // Three committed Gulf-Air-length days (3 x 11.25h = 33.75h): a 4th day at 9h would be 42.75h > 42h -> target 3.
    const gulfLike = new Map([["Monday", 11.25], ["Wednesday", 11.25], ["Friday", 11.25]]);
    expect(computeCapAwareTargetWorkDays({ ...base, hardWeeklyHoursCap: 42, committedHoursByDay: gulfLike })).toMatchObject({ targetWorkDays: 3, committedDays: 3, committedHours: 33.75, capLimited: true });
    // Committed days already at/over the normal target: the normal target (never below what demand committed).
    const six = new Map(DAYS.slice(0, 6).map((d) => [d, 9]));
    expect(computeCapAwareTargetWorkDays({ ...base, hardWeeklyHoursCap: 999, committedHoursByDay: six })).toMatchObject({ targetWorkDays: 5, capLimited: false });
  });

  it("NORMAL: an employee whose own achievable maximum is 4 works 4 days and gets NO anomaly finding (no roster_target_shortfall, no separated_off_days, no consecutive_off_violation, no top-up shortfall note)", () => {
    // Demand only on Monday; everything else comes from the (cap-aware) top-up.
    const flights = dailyFlights().filter((f) => f.day_of_week === "Monday" && f.operator_type === "atlas_managed");
    const p = generateDraftWeeklyPlan(flights, [makeEmployee({ id: "solo", skills: ["Boarding"] })], [], CONFIG, DAYS, "W", WEEK);
    const worked = workPattern(p, "solo");
    expect(worked.filter(Boolean).length).toBe(4);
    expect(p.rosterTargets).toEqual([expect.objectContaining({ employeeId: "solo", targetWorkDays: 4, capLimited: true })]);
    expect(p.issues.filter((i) => i.employeeId === "solo")).toEqual([]);
    expect(p.configurationIssues.some((c) => c.requirementId === "hard-cap-roster-top-up-shortfall")).toBe(false);
    // The 3 OFF days are spread so no block exceeds max_consecutive_off_days (2).
    const status = worked.map((w) => ({ status: w ? ("working" as const) : ("off" as const) }));
    let longest = 0;
    for (let i = 0, run = 0; i < 14; i++) longest = Math.max(longest, (run = status[i % 7].status === "off" ? run + 1 : 0));
    expect(longest).toBeLessThanOrEqual(2);
  });

  it("FLAGGED: the hours cap leaves room for 5 days (45h cap, 5 x 9h) but only 4 are rostered because another hard cap closed a day — roster_target_shortfall fires, naming the closed day", () => {
    // max 2 consecutive work days + a real incoming streak of 2: Monday is
    // closed, and W W O W W O W / O W W O W W O can hold at most 4 days after
    // it. The hours arithmetic alone (target 5) says 5 would fit.
    const config: Config = { ...CONFIG, hard_weekly_hours_cap: 45, max_consecutive_work_days: 2 };
    const flights = dailyFlights().filter((f) => f.day_of_week === "Tuesday" && f.operator_type === "atlas_managed");
    const seeds = new Map<string, IncomingConsecutiveWorkDaysSeed>([["solo", { source: "prior_plan", streak: 2, lowerBound: false }]]);
    const p = generateDraftWeeklyPlan(flights, [makeEmployee({ id: "solo", skills: ["Boarding"] })], [], config, DAYS, "W", WEEK, new Map(), "unknown", { incomingConsecutiveWorkDays: seeds });
    expect(workPattern(p, "solo").filter(Boolean).length).toBe(4);
    const target = p.rosterTargets.find((t) => t.employeeId === "solo")!;
    expect(target).toMatchObject({ targetWorkDays: 5, capLimited: false });
    expect(target.capClosedFreeDays!.length).toBeGreaterThan(0);
    const flagged = p.issues.filter((i) => i.type === "roster_target_shortfall");
    expect(flagged).toHaveLength(1);
    expect(flagged[0].employeeId).toBe("solo");
    expect(flagged[0].description).toContain("rostered 4 work day(s) this week but their target is the normal 5");
    expect(flagged[0].description).toContain(`because a hard cap closed ${target.capClosedFreeDays!.join(", ")}`);
  });

  it("checkRosterTargetShortfall is exactly the distinction: at-target -> nothing; below target WITH a cap-closed day -> flagged; below target with no cap involvement (rest) -> not re-flagged by this check", () => {
    const week = (workedDays: number) => makeEmployee({ id: "e", name: "E", weekly_shifts: DAYS.map((d, i) => ({ day_of_week: d, status: i < workedDays ? ("working" as const) : ("off" as const), shift_code: i < workedDays ? "NR01" : null })) });
    const t4 = { ...computeCapAwareTargetWorkDays({ daysOrder: DAYS, weekStart: WEEK, normalTargetWorkDays: 5, hardWeeklyHoursCap: 42 }) };
    const t5 = { ...computeCapAwareTargetWorkDays({ daysOrder: DAYS, weekStart: WEEK, normalTargetWorkDays: 5, hardWeeklyHoursCap: 45 }) };
    expect(checkRosterTargetShortfall(week(4), DAYS, t4)).toBeNull(); // forced 4/3 = normal
    expect(checkRosterTargetShortfall(week(4), DAYS, { ...t4, capClosedFreeDays: ["Friday"] })).toBeNull(); // still at its target
    expect(checkRosterTargetShortfall(week(4), DAYS, { ...t5, capClosedFreeDays: ["Friday"] })?.type).toBe("roster_target_shortfall");
    expect(checkRosterTargetShortfall(week(4), DAYS, t5)).toBeNull(); // no cap involvement: pre-milestone behaviour
    expect(checkRosterTargetShortfall(week(3), DAYS, undefined)).toBeNull(); // no target (static/fixed/Profiling) = nothing to check
  });

  it("caps non-binding: every target is the normal 5 (the pre-phase fixed number) and no new warning type appears on the demo", () => {
    const boundary = deriveFallbackBoundaryContext(EMPLOYEES, DAYS_WITH_DATA, CURRENT_WEEK_START);
    const p = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CAPS_OFF, DAYS_WITH_DATA, CURRENT_WEEK_LABEL, CURRENT_WEEK_START, boundary, "fallback_static_baseline");
    expect(p.rosterTargets.length).toBeGreaterThan(0);
    expect(p.rosterTargets.every((t) => t.targetWorkDays === 5 && !t.capLimited)).toBe(true);
    expect(p.issues.filter((i) => i.type === "roster_target_shortfall")).toEqual([]);
    expect(p.hardCapRepairs).toEqual([]);
  });
});

describe("PHASE 2, part B — the three pinned phase-1 scenarios are now resolved by the bounded cross-employee repair pass", () => {
  it("Profiling: Monday is handed from p-tired to p-fresh, p-tired covers Tuesday — full coverage, no cap broken, the explanation names the swap", () => {
    const before = profilingScenario(false);
    expect(before.result.conflicts).toHaveLength(1); // phase-1 behaviour (repair off): Tuesday one short
    const { result, repairsOut, incoming } = profilingScenario();
    // (1) full coverage
    expect(result.conflicts).toEqual([]);
    expect(result.generatedShiftsByDay["Monday"].map((g) => g.employeeId)).toEqual(["p-fresh"]);
    expect(result.generatedShiftsByDay["Tuesday"].map((g) => g.employeeId).sort()).toEqual(["p-fresh", "p-tired"]);
    // (2) neither cap broken for anyone
    for (const id of ["p-tired", "p-fresh"]) {
      const worked = DAYS.map((d) => result.generatedShiftsByDay[d].some((g) => g.employeeId === id));
      expect(maxRun(worked, incoming.get(id)!), id).toBeLessThanOrEqual(5);
      expect(patternHoursOf(DAYS.map((d) => result.generatedShiftsByDay[d].find((g) => g.employeeId === id)?.shiftCode ?? null), WEEK)).toBeLessThanOrEqual(42);
    }
    // (3) the explanation names what happened
    expect(repairsOut).toHaveLength(1);
    expect(repairsOut[0]).toMatchObject({ population: "profiling_mesure", kind: "reallocate_for_gap", team: "Profiling", reassignedDay: "Monday", targetDay: "Tuesday", fromEmployeeId: "p-tired", toEmployeeId: "p-fresh", cap: "consecutive_work_days" });
    expect(repairsOut[0].explanation).toBe(
      "Monday Profiling work reassigned from P Tired to P Fresh (MT03) so P Tired could cover Tuesday's short Profiling need (MT03) within the 5-consecutive-work-day cap."
    );
    expect(result.generatedShiftsByDay["Monday"][0].hardCapRepairReason).toBe(repairsOut[0].explanation);
    expect(result.generatedShiftsByDay["Tuesday"].find((g) => g.employeeId === "p-tired")!.hardCapRepairReason).toBe(repairsOut[0].explanation);
    expect(result.generatedShiftsByDay["Tuesday"].find((g) => g.employeeId === "p-fresh")!.hardCapRepairReason).toBeUndefined();
  });

  it("Air France (the streak-ordering gap it pins): Monday is handed from af-1 to fresh af-4, af-1 covers Tuesday — every flight day fully staffed, nobody past 5 in a row, explanation names the swap", () => {
    // The pinned phase-1 claim is about the CONSECUTIVE cap's ordering. It is
    // isolated here with the hours cap non-binding (see the next test for
    // why the full 42h default makes this exact fixture infeasible).
    const before = airFranceScenario(CONSECUTIVE_ONLY, false);
    expect(before.result.conflicts.map((c) => c.dayOfWeek)).toEqual(["Tuesday"]);
    const { team, incoming, result, repairsOut, pattern } = airFranceScenario(CONSECUTIVE_ONLY);
    expect(result.conflicts).toEqual([]);
    for (const d of DAYS) expect(result.generatedShiftsByDay[d].filter((g) => g.coversRoles.includes("Air France")), d).toHaveLength(3);
    for (const e of team) expect(maxRun(pattern(e.id).map(Boolean), incoming.get(e.id)!), e.id).toBeLessThanOrEqual(5);
    expect(repairsOut).toHaveLength(1);
    expect(repairsOut[0]).toMatchObject({ population: "foreign_company", kind: "reallocate_for_gap", team: "Air France", reassignedDay: "Monday", targetDay: "Tuesday", fromEmployeeId: "af-1", toEmployeeId: "af-4", cap: "consecutive_work_days" });
    expect(repairsOut[0].explanation).toBe("Monday Air France work reassigned from AF 1 to AF 4 (MT03) so AF 1 could cover Tuesday's short Air France need (MT03) within the 5-consecutive-work-day cap.");
    expect(result.generatedShiftsByDay["Monday"].find((g) => g.employeeId === "af-4")!.hardCapRepairReason).toBe(repairsOut[0].explanation);
  });

  it("Air France under the FULL default caps: the same fixture is provably infeasible (5 members x at most 4 days of 9h under 42h = 20 < 21 needed) — the repair searches, finds no legal move, and the gap stays honestly reported", () => {
    // Every code covering the 07:40-12:10 window is 9h (MT03); 5 x 9h = 45h > 42h.
    const { result, repairsOut, pattern, team } = airFranceScenario(CONFIG);
    for (const e of team) expect(patternHoursOf(pattern(e.id), WEEK), e.id).toBeLessThanOrEqual(42);
    expect(team.reduce((n, e) => n + pattern(e.id).filter(Boolean).length, 0)).toBe(20); // the hours cap's hard ceiling
    expect(repairsOut).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ dayOfWeek: "Tuesday", needed: 3, covered: 2 });
    expect(result.conflicts[0].capRepair).toMatchObject({ budget: HARD_CAP_REPAIR_ATTEMPT_BUDGET, budgetExhausted: false });
    expect(result.conflicts[0].capRepair!.attemptsUsed).toBeGreaterThan(0);
  });

  it("youssef-el-amrani (real demo data): his Monday moves to Saturday — no more 3-day OFF block, still 4 days / 36h, no cap broken, no new unfilled duty, explanation names the move", () => {
    const boundary = deriveFallbackBoundaryContext(EMPLOYEES, DAYS_WITH_DATA, CURRENT_WEEK_START);
    const run = (hardCapRepair: boolean) =>
      generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_LABEL, CURRENT_WEEK_START, boundary, "fallback_static_baseline", { hardCapRepair });
    const before = run(false);
    expect(workPattern(before, "youssef-el-amrani")).toEqual([true, true, true, true, false, false, false]);
    expect(before.issues.some((i) => i.type === "consecutive_off_violation" && i.employeeId === "youssef-el-amrani")).toBe(true);

    const p = run(true);
    const worked = workPattern(p, "youssef-el-amrani");
    expect(worked).toEqual([false, true, true, true, false, true, false]);
    expect(p.issues.some((i) => i.type === "consecutive_off_violation" && i.employeeId === "youssef-el-amrani")).toBe(false);
    expect(maxRun(worked)).toBeLessThanOrEqual(5);
    expect(weekHours(p, "youssef-el-amrani", CURRENT_WEEK_START)).toBe(36);
    expect(p.issues.filter((i) => i.type === "unfilled_duty")).toEqual([]);
    expect(p.issues.filter((i) => i.type === "rest_violation")).toEqual([]);
    const mine = p.hardCapRepairs.filter((r) => r.fromEmployeeId === "youssef-el-amrani");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ population: "flexible_pool", kind: "shift_own_day_for_off_run", reassignedDay: "Monday", targetDay: "Saturday", cap: "hard_weekly_hours" });
    expect(mine[0].explanation).toBe(
      "Youssef El Amrani's Monday work moved to Saturday (MT01) so their week stays within the 42h hard weekly hours cap while avoiding a 3-day OFF block (max 2 consecutive OFF days); Monday's Profiling coverage there is held by the dedicated team."
    );
    expect(p.generatedShiftsByDay["Saturday"].find((g) => g.employeeId === "youssef-el-amrani")!.hardCapRepairReason).toBe(mine[0].explanation);
    // Monday's Profiling demand really is covered by the dedicated Profiling team (no Profiling BLOCKING conflict, no unfilled duty).
    expect(p.configurationIssues.some((c) => c.requirementId === "specialized-demand-conflict-Profiling-Monday")).toBe(false);
  });

  it("flexible pool (Stage 6): the same streak-ordering gap — Monday is handed to the fresh ACEs so the tired ones cover Tuesday; Tuesday's Gate/Boarding unfilled_duty disappears, no cap broken", () => {
    const team = [
      makeEmployee({ id: "a-tired-1", name: "A Tired 1", skills: ["Gate", "Boarding"] }),
      makeEmployee({ id: "a-tired-2", name: "A Tired 2", skills: ["Gate", "Boarding"] }),
      makeEmployee({ id: "b-fresh-1", name: "B Fresh 1", skills: ["Gate", "Boarding"] }),
      makeEmployee({ id: "b-fresh-2", name: "B Fresh 2", skills: ["Gate", "Boarding"] }),
    ];
    // Monday: one RAM flight (Gate + Boarding); Tuesday: two at the same time (2 Gate + 2 Boarding).
    const flights = [
      makeFlight({ id: "m1", day_of_week: "Monday", flight_date: flightDateFor(WEEK, "Monday") }),
      makeFlight({ id: "t1", day_of_week: "Tuesday", flight_date: flightDateFor(WEEK, "Tuesday") }),
      makeFlight({ id: "t2", day_of_week: "Tuesday", flight_date: flightDateFor(WEEK, "Tuesday") }),
    ];
    const seeds = new Map<string, IncomingConsecutiveWorkDaysSeed>(team.map((e) => [e.id, { source: "prior_plan", streak: e.id.startsWith("a-") ? 4 : 0, lowerBound: false }]));
    const gen = (hardCapRepair: boolean) => generateDraftWeeklyPlan(flights, team, [], CONFIG, DAYS, "W", WEEK, new Map(), "unknown", { incomingConsecutiveWorkDays: seeds, hardCapRepair });
    const before = gen(false);
    expect(unfilledDays(before, "Gate")).toEqual(["Tuesday"]);
    expect(unfilledDays(before, "Boarding")).toEqual(["Tuesday"]);
    const p = gen(true);
    expect(unfilledDays(p, "Gate")).toEqual([]);
    expect(unfilledDays(p, "Boarding")).toEqual([]);
    for (const e of team) {
      expect(maxRun(workPattern(p, e.id), e.id.startsWith("a-") ? 4 : 0), e.id).toBeLessThanOrEqual(5);
      expect(weekHours(p, e.id, WEEK), e.id).toBeLessThanOrEqual(42);
    }
    expect(p.issues.filter((i) => i.type === "rest_violation")).toEqual([]);
    expect(p.hardCapRepairs.map((r) => `${r.kind}|${r.fromEmployeeId}->${r.toEmployeeId}|${r.reassignedDay}->${r.targetDay}|${r.cap}`)).toEqual([
      "reallocate_for_gap|a-tired-1->b-fresh-1|Monday->Tuesday|consecutive_work_days",
      "reallocate_for_gap|a-tired-2->b-fresh-2|Monday->Tuesday|consecutive_work_days",
    ]);
    expect(p.hardCapRepairs[0].explanation).toBe("Monday reassigned from A Tired 1 to B Fresh 1 (MT03) so A Tired 1 could cover Tuesday's otherwise-uncovered demand (MT03) within the 5-consecutive-work-day cap.");
    expect(p.generatedShiftsByDay["Monday"].find((g) => g.employeeId === "b-fresh-1")!.hardCapRepairReason).toBe(p.hardCapRepairs[0].explanation);
  });

  it("demo, default caps: the caps no longer add ANY consecutive_off_violation over the caps-off plan, and nobody generation-driven breaks either cap", () => {
    const boundary = deriveFallbackBoundaryContext(EMPLOYEES, DAYS_WITH_DATA, CURRENT_WEEK_START);
    const gen = (config: Config) => generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], config, DAYS_WITH_DATA, CURRENT_WEEK_LABEL, CURRENT_WEEK_START, boundary, "fallback_static_baseline");
    const off = gen(CAPS_OFF);
    const on = gen(CONFIG);
    const violators = (p: DraftWeeklyPlan) => p.issues.filter((i) => i.type === "consecutive_off_violation").map((i) => i.employeeId).sort();
    expect(violators(on)).toEqual(violators(off));
    for (const e of EMPLOYEES.filter(isGenerationDrivenPopulation)) {
      expect(maxRun(workPattern(on, e.id)), e.id).toBeLessThanOrEqual(5);
      expect(weekHours(on, e.id, CURRENT_WEEK_START), e.id).toBeLessThanOrEqual(42);
    }
  });
});

describe("PHASE 2, part B — Gulf Air's structural shortfall stays an honest, unresolved BLOCKING gap", () => {
  const gulfTeam = () => [
    ...[1, 2, 3, 4, 5, 6, 7].map((i) => makeEmployee({ id: `gf-ace-${i}`, name: `GF Ace ${i}`, assignment: "Gulf Air", team_role: "ace", foreign_company_authorizations: ["Gulf Air"] })),
    makeEmployee({ id: "gf-leader", name: "GF Leader", assignment: "Gulf Air", team_role: "leader", foreign_company_authorizations: ["Gulf Air"] }),
  ];
  const gulfFlights = () =>
    ["Monday", "Wednesday", "Friday", "Sunday"].map((day) =>
      makeFlight({ id: `gf-${day}`, flight_number: "GF105", airline: "Gulf Air", route: "CMN → BAH", destination: "BAH", aircraft: "Airbus A320", scheduled_departure: "09:00", day_of_week: day, flight_date: flightDateFor(WEEK, day), operator_type: "self_managed" })
    );

  it("the whole 8-person team is needed on each of 4 flight days, every covering code is >= 11.25h, 3 x 11.25 + 11.25 > 42h: nobody is OFF on any day to take over, so no move exists and Sunday stays BLOCKING", () => {
    const repairsOut: import("../lib/planning/hard-cap-repair").HardCapRepair[] = [];
    const { generatedShiftsByDay, conflicts } = generateForeignCompanyShifts(DAYS, gulfTeam(), gulfFlights(), ["Gulf Air"], 15, WEEK, new Map(), undefined, undefined, {
      caps: resolveHardWorkCaps(CONFIG), incomingStreakByEmployee: new Map(), repairsOut,
    });
    for (const day of ["Monday", "Wednesday", "Friday"]) expect(generatedShiftsByDay[day]).toHaveLength(8);
    for (const g of generatedShiftsByDay["Monday"]) expect(getShiftDurationHours(g.shiftCode, flightDateFor(WEEK, "Monday"))).toBeGreaterThanOrEqual(11.25);
    expect(generatedShiftsByDay["Sunday"]).toEqual([]);
    expect(repairsOut).toEqual([]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ team: "Gulf Air", dayOfWeek: "Sunday", needed: 8, covered: 0 });
    expect(conflicts[0].capExcluded).toHaveLength(8);
    expect(conflicts[0].capExcluded!.every((x) => x.reason === "hard_weekly_hours")).toBe(true);
    expect(conflicts[0].capRepair).toMatchObject({ budgetExhausted: false });
  });

  it("through the full pipeline the BLOCKING issue says the bounded repair ran and found no legal reallocation", () => {
    const p = generateDraftWeeklyPlan(gulfFlights(), gulfTeam(), [], CONFIG, DAYS, "W", WEEK);
    const sunday = p.configurationIssues.find((c) => c.requirementId === "specialized-demand-conflict-Gulf Air-Sunday")!;
    expect(sunday.description.startsWith("BLOCKING: Gulf Air needed 8 staff member(s) for its Sunday operation")).toBe(true);
    expect(sunday.description).toContain("8 otherwise rested, compatible team member(s) were excluded by a HARD cap");
    expect(sunday.description).toMatch(/The bounded cross-employee repair pass \(hard-constraints milestone phase 2\) evaluated \d+ candidate move\(s\) and found no legal reallocation/);
    expect(p.hardCapRepairs).toEqual([]);
  });

  it("the real 2026-09-21-regime demo week still reports its Gulf Air Sunday gap (and the repair never touches Gulf Air)", () => {
    const p = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, "W", WEEK);
    expect(p.configurationIssues.some((c) => c.requirementId === "specialized-demand-conflict-Gulf Air-Sunday" && c.description.startsWith("BLOCKING"))).toBe(true);
    expect(p.hardCapRepairs.some((r) => r.team === "Gulf Air")).toBe(false);
  });
});

describe("PHASE 2, part B — no-op, determinism, fixed-cycle exemption, bounded termination", () => {
  it("NO-OP: a week in which no hard cap ever excludes anyone is byte-identical with the repair pass on or off", () => {
    // Two days of demand only: nobody gets near 5 days or 42h at Stage 6/foreign/Profiling level.
    const flights = dailyFlights().filter((f) => f.day_of_week === "Monday" || f.day_of_week === "Tuesday");
    const gen = (hardCapRepair: boolean) => {
      const { generatedAt, ...rest } = generateDraftWeeklyPlan(flights, smallWorkforce(), [], CONFIG, DAYS, "W", WEEK, new Map(), "unknown", { hardCapRepair });
      void generatedAt;
      return rest;
    };
    const on = gen(true);
    expect(on.hardCapExclusions.filter((x) => x.population === "flexible_pool" || x.population === "profiling_mesure" || x.population === "foreign_company")).toEqual([]);
    expect(on.hardCapRepairs).toEqual([]);
    expect(JSON.stringify(on)).toBe(JSON.stringify(gen(false)));
    // ...and the demo with the caps non-binding is byte-identical to repair-off too.
    const boundary = deriveFallbackBoundaryContext(EMPLOYEES, DAYS_WITH_DATA, CURRENT_WEEK_START);
    const demo = (hardCapRepair: boolean) => {
      const { generatedAt, ...rest } = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CAPS_OFF, DAYS_WITH_DATA, CURRENT_WEEK_LABEL, CURRENT_WEEK_START, boundary, "fallback_static_baseline", { hardCapRepair });
      void generatedAt;
      return JSON.stringify(rest);
    };
    expect(demo(true)).toBe(demo(false));
  });

  it("NO-OP at the core: a slot population with exclusions but no gap returns the very same assignment object", () => {
    const input: SlotRepairInput = {
      population: "profiling_mesure", team: "Profiling",
      ctx: { daysOrder: DAYS, weekStart: WEEK, minimumRestHours: 15, caps: resolveHardWorkCaps(CONFIG), incomingStreakByEmployee: new Map(), priorWeekBoundaryContext: new Map() },
      preferExtended: false, poolIds: ["a"], names: new Map(),
      groupsByDay: Object.fromEntries(DAYS.map((d) => [d, d === "Monday" ? [{ key: "g", window: { start: "13:00", end: "14:00" }, needed: 1, eligibleIds: new Set(["a"]) }] : []])),
      assignmentsByDay: Object.fromEntries(DAYS.map((d) => [d, d === "Monday" ? [{ employeeId: "a", shiftCode: "NR01", groupKey: "g" }] : []])),
    };
    const out = repairSlotPopulationGaps(input);
    expect(out.assignmentsByDay).toBe(input.assignmentsByDay);
    expect(out.repairs).toEqual([]);
    expect(out.search.attemptsUsed).toBe(0);
  });

  it("DETERMINISM: identical input -> identical output (whole pipeline, twice), and the core's result does not depend on the pool's input order", () => {
    const boundary = deriveFallbackBoundaryContext(EMPLOYEES, DAYS_WITH_DATA, CURRENT_WEEK_START);
    const demo = () => {
      const { generatedAt, ...rest } = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_LABEL, CURRENT_WEEK_START, boundary, "fallback_static_baseline");
      void generatedAt;
      return JSON.stringify(rest);
    };
    expect(demo()).toBe(demo());
    expect(JSON.stringify(airFranceScenario(CONSECUTIVE_ONLY).result)).toBe(JSON.stringify(airFranceScenario(CONSECUTIVE_ONLY).result));
    expect(JSON.stringify(profilingScenario().result)).toBe(JSON.stringify(profilingScenario().result));
    // The core, fed the SAME pre-repair week with the pool listed in two different orders.
    const pre = airFranceScenario(CONSECUTIVE_ONLY, false);
    const ids = ["af-1", "af-2", "af-3", "af-4", "af-5"];
    const input = (poolIds: string[]): SlotRepairInput => ({
      population: "foreign_company", team: "Air France",
      ctx: { daysOrder: DAYS, weekStart: WEEK, minimumRestHours: 15, caps: resolveHardWorkCaps(CONSECUTIVE_ONLY), incomingStreakByEmployee: pre.incoming, priorWeekBoundaryContext: new Map() },
      preferExtended: false, poolIds, names: new Map(ids.map((id) => [id, id])),
      groupsByDay: Object.fromEntries(DAYS.map((d) => [d, [{ key: d, window: pre.result.conflicts[0].window, needed: 3, eligibleIds: new Set([...poolIds].reverse()) }]])),
      assignmentsByDay: Object.fromEntries(DAYS.map((d) => [d, pre.result.generatedShiftsByDay[d].map((g) => ({ employeeId: g.employeeId, shiftCode: g.shiftCode, groupKey: d }))])),
    });
    const a = repairSlotPopulationGaps(input(ids));
    const b = repairSlotPopulationGaps(input(["af-5", "af-3", "af-1", "af-4", "af-2"]));
    expect(a.repairs.length).toBeGreaterThan(0);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("FIXED-CYCLE EXEMPT: at the default caps no repair ever names a fixed-cycle or static employee, and their rosters stay byte-identical to the pre-phase fixture", () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures", "pre-hard-caps-demo-plan.json"), "utf8")) as { roster: Record<string, string> };
    const boundary = deriveFallbackBoundaryContext(EMPLOYEES, DAYS_WITH_DATA, CURRENT_WEEK_START);
    const p = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_LABEL, CURRENT_WEEK_START, boundary, "fallback_static_baseline");
    expect(p.hardCapRepairs.length).toBeGreaterThan(0);
    const staticIds = new Set(EMPLOYEES.filter((e) => !isGenerationDrivenPopulation(e)).map((e) => e.id));
    for (const r of p.hardCapRepairs) for (const id of [r.fromEmployeeId, r.toEmployeeId, r.filledByEmployeeId]) if (id) expect(staticIds.has(id), id).toBe(false);
    for (const e of EMPLOYEES.filter((x) => usesFixedCycleRotation(x.assignment))) {
      const roster = DAYS_WITH_DATA.map((day) => { const r = p.rosterEntries.find((x) => x.employee_id === e.id && x.day_of_week === day)!; return r.status === "working" ? r.shift_code : "OFF"; }).join("|");
      expect(roster, e.id).toBe(fixture.roster[e.id]);
    }
  });

  it("BOUNDED: a pathological week (41 cap-blocked candidates x 5 hand-off days x 40 would-be stand-ins who all fail at the last check) stops at its attempt budget, changes nothing, and reports the exhausted search", () => {
    // 41 X members work Tue-Sat (NR01); Sunday needs all 41 of them, but for
    // each a Sunday would be a 6th consecutive day. 40 Y members are OFF all
    // week and eligible for every Tue-Sat need, so every (X, day) hand-off
    // enumerates all 40 of them — but the Tue-Sat need window (02:00-23:30)
    // is one no catalog code covers, so each Y fails at its final code check.
    // Unbounded, that is 41 x 5 x (1 + 40) = 8405 evaluations for a week with
    // no solution at all.
    const xs = Array.from({ length: 41 }, (_, i) => `x-${String(i).padStart(2, "0")}`);
    const ys = Array.from({ length: 40 }, (_, i) => `y-${String(i).padStart(2, "0")}`);
    const worked = ["Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const input = (budget?: number): SlotRepairInput => ({
      population: "foreign_company", team: "Stress",
      ctx: { daysOrder: DAYS, weekStart: WEEK, minimumRestHours: 15, caps: resolveHardWorkCaps(CONSECUTIVE_ONLY), incomingStreakByEmployee: new Map(), priorWeekBoundaryContext: new Map() },
      preferExtended: false, poolIds: [...xs, ...ys], names: new Map(),
      groupsByDay: Object.fromEntries(
        DAYS.map((d) => [
          d,
          d === "Sunday"
            ? [{ key: d, window: { start: "13:00", end: "14:00" }, needed: xs.length, eligibleIds: new Set(xs) }]
            : worked.includes(d)
              ? [{ key: d, window: { start: "02:00", end: "23:30" }, needed: xs.length, eligibleIds: new Set([...xs, ...ys]) }]
              : [],
        ])
      ),
      assignmentsByDay: Object.fromEntries(DAYS.map((d) => [d, worked.includes(d) ? xs.map((id) => ({ employeeId: id, shiftCode: "NR01", groupKey: d })) : []])),
      budget,
    });
    const t0 = Date.now();
    const small = input(50);
    const out = repairSlotPopulationGaps(small);
    expect(out.search).toEqual({ attemptsUsed: 50, budget: 50, budgetExhausted: true });
    expect(out.repairs).toEqual([]);
    expect(out.assignmentsByDay).toBe(small.assignmentsByDay); // never half-repaired
    // The default budget (2000 < the 8405 unbounded evaluations) is hit too — it still terminates, unchanged, honest.
    const dflt = input();
    const full = repairSlotPopulationGaps(dflt);
    expect(full.search).toEqual({ attemptsUsed: HARD_CAP_REPAIR_ATTEMPT_BUDGET, budget: HARD_CAP_REPAIR_ATTEMPT_BUDGET, budgetExhausted: true });
    expect(full.repairs).toEqual([]);
    expect(full.assignmentsByDay).toBe(dflt.assignmentsByDay);
    expect(Date.now() - t0).toBeLessThan(20000);
  });
});
