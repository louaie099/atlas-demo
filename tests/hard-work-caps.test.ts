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
import { auditAverageWeeklyHoursFeasibility, checkRestBetweenDays } from "../lib/planning/validation";
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

  it("the Stage-6.5 top-up never adds a day past the cap either (reported once, with the structural 5 x shortest-code arithmetic)", () => {
    // Demand only on Monday -> the top-up must supply the other days.
    const flights = dailyFlights().filter((f) => f.day_of_week === "Monday" && f.operator_type === "atlas_managed");
    const p = generateDraftWeeklyPlan(flights, [makeEmployee({ id: "solo", skills: ["Boarding"] })], [], CONFIG, DAYS, "W", WEEK);
    expect(weekHours(p, "solo", WEEK)).toBeLessThanOrEqual(42);
    expect(workPattern(p, "solo").filter(Boolean).length).toBe(4); // 5 x 9h (shortest GMT code) = 45h > 42h
    const note = p.configurationIssues.find((c) => c.requirementId === "hard-cap-roster-top-up-shortfall")!;
    expect(note.description.startsWith("BLOCKING")).toBe(false);
    expect(note.description).toContain("Structural conflict: 5 work days x the shortest catalog code (9h) = 45h already exceeds the 42h hard weekly hours cap");
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
    expect(atDefault.configurationIssues.some((c) => c.requirementId === "hard-cap-roster-top-up-shortfall")).toBe(true);
    for (const e of EMPLOYEES.filter(isGenerationDrivenPopulation)) {
      const asEmployee = { ...e, weekly_shifts: DAYS_WITH_DATA.map((day, i) => { const c = defaultRoster[e.id].split("|")[i]; return { day_of_week: day, status: c === "OFF" ? ("off" as const) : ("working" as const), shift_code: c === "OFF" ? null : c }; }) };
      const hard = checkRestBetweenDays(asEmployee, DAYS_WITH_DATA, CONFIG, CURRENT_WEEK_START).filter((i) => i.type === "rest_violation");
      expect(hard, e.id).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------

describe("PHASE-2 SCENARIOS — avoidable gaps the naive phase-1 filter creates (documented, not fixed here)", () => {
  // Each scenario: the phase-1 filter correctly refuses the illegal day and
  // reports the shortfall — but a streak-aware (or cross-employee repair)
  // allocation that exists, and is checked here by construction, would
  // have covered it. These are the concrete targets for phase 2.

  it("foreign company: least-used-first ignores incoming streaks, so Monday spends the three members already on day 4 and Tuesday is one short — a streak-aware allocation covers every day", () => {
    const team = [1, 2, 3, 4, 5].map((i) => makeEmployee({ id: `af-${i}`, name: `AF ${i}`, assignment: "Air France", foreign_company_authorizations: ["Air France"] }));
    const flights = dailyFlights().filter((f) => f.airline === "Air France");
    const incoming = new Map([["af-1", 4], ["af-2", 4], ["af-3", 4], ["af-4", 0], ["af-5", 0]]);
    const { generatedShiftsByDay, conflicts } = generateForeignCompanyShifts(DAYS, team, flights, ["Air France"], 15, WEEK, new Map(), undefined, undefined, {
      caps: resolveHardWorkCaps(CONFIG),
      incomingStreakByEmployee: incoming,
    });
    expect(generatedShiftsByDay["Monday"].map((g) => g.employeeId).sort()).toEqual(["af-1", "af-2", "af-3"]); // all three reach day 5
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ team: "Air France", dayOfWeek: "Tuesday", needed: 3, covered: 2 });
    expect(conflicts[0].capExcluded).toEqual([{ employeeId: "af-1", reason: "consecutive_work_days" }, { employeeId: "af-2", reason: "consecutive_work_days" }, { employeeId: "af-3", reason: "consecutive_work_days" }]);
    // A legal full-coverage allocation exists (3 per day, nobody past 5 in a row):
    const smarter: string[][] = [["af-4", "af-5", "af-1"], ["af-2", "af-3", "af-4"], ["af-1", "af-5", "af-2"], ["af-3", "af-4", "af-5"], ["af-1", "af-2", "af-3"], ["af-4", "af-5", "af-1"], ["af-2", "af-3", "af-4"]];
    for (const day of smarter) expect(new Set(day).size).toBe(3);
    for (const e of team) expect(maxRun(smarter.map((day) => day.includes(e.id)), incoming.get(e.id)!), e.id).toBeLessThanOrEqual(5);
  });

  it("Profiling: Monday's least-used tie goes to the agent already on day 4, so Tuesday's second agent is missing — giving Monday to the fresh agent covers both days", () => {
    const pool = [makeEmployee({ id: "p-tired", name: "P Tired", assignment: "Profiling", skills: ["Profiling"] }), makeEmployee({ id: "p-fresh", name: "P Fresh", assignment: "Profiling", skills: ["Profiling"] })];
    const flights = dailyFlights().filter((f) => f.operator_type === "atlas_managed" && (f.day_of_week === "Monday" || f.day_of_week === "Tuesday"));
    const reqs: StaffingRequirement[] = flights.map((f) => ({
      id: `r-${f.day_of_week}`, flight_id: f.id, role: "Profiling", baseline_requirement: 1, additional_requirement: 0,
      total_requirement: f.day_of_week === "Tuesday" ? 2 : 1, source: "fixed_rule", reasoning: "", needs_configuration: false,
    }));
    const demandByDay = Object.fromEntries(DAYS.map((d) => [d, aggregateDailyDemand(d, flights, reqs)]));
    const incoming = new Map([["p-tired", 4], ["p-fresh", 0]]);
    const { generatedShiftsByDay, conflicts } = generateProfilingMesureShifts(DAYS, pool, demandByDay, 15, WEEK, new Map(), { caps: resolveHardWorkCaps(CONFIG), incomingStreakByEmployee: incoming });
    expect(generatedShiftsByDay["Monday"].map((g) => g.employeeId)).toEqual(["p-tired"]); // now on day 5
    expect(generatedShiftsByDay["Tuesday"].map((g) => g.employeeId)).toEqual(["p-fresh"]);
    expect(conflicts).toEqual([
      { team: "Profiling", dayOfWeek: "Tuesday", window: conflicts[0].window, needed: 2, covered: 1, capExcluded: [{ employeeId: "p-tired", reason: "consecutive_work_days" }] },
    ]);
    // Avoidable: Monday = p-fresh, Tuesday = both — p-tired's Monday OFF
    // resets the carried-in streak, p-fresh works 2 days; nobody passes 5.
    expect(maxRun([false, true, false, false, false, false, false], incoming.get("p-tired")!)).toBeLessThanOrEqual(5);
    expect(maxRun([true, true, false, false, false, false, false], incoming.get("p-fresh")!)).toBeLessThanOrEqual(5);
  });

  it("Stage 6 front-loading (real demo data): youssef-el-amrani is rostered Mon-Thu on MT01, then the 42h cap closes Fri-Sun — a 3-day OFF block (consecutive_off_violation) that spreading his 4 days would avoid", () => {
    const boundary = deriveFallbackBoundaryContext(EMPLOYEES, DAYS_WITH_DATA, CURRENT_WEEK_START);
    const p = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_LABEL, CURRENT_WEEK_START, boundary, "fallback_static_baseline");
    expect(workPattern(p, "youssef-el-amrani")).toEqual([true, true, true, true, false, false, false]);
    expect(p.hardCapExclusions.filter((x) => x.employeeId === "youssef-el-amrani" && x.population === "flexible_pool").map((x) => `${x.dayOfWeek}:${x.reason}`)).toEqual([
      "Friday:hard_weekly_hours",
      "Saturday:hard_weekly_hours",
      "Sunday:hard_weekly_hours",
    ]);
    expect(p.issues.some((i) => i.type === "consecutive_off_violation" && i.employeeId === "youssef-el-amrani")).toBe(true);
  });
});
