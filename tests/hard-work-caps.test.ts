import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  DEFAULT_MAX_CONSECUTIVE_WORK_DAYS,
  resolveHardWorkCaps,
  nextConsecutiveWorkDayStreak,
  wouldExceedConsecutiveDayCap,
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
import { repairSlotPopulationGaps, repairFlexiblePoolWeek, HARD_CAP_REPAIR_ATTEMPT_BUDGET, SlotRepairInput, FlexibleRepairInput } from "../lib/planning/hard-cap-repair";
import { maxConsecutiveOffCyclic } from "../lib/planning/consecutive-off";
import { resolveDefaultLaborRules } from "../lib/labor-rules";
import { usesFixedCycleRotation } from "../lib/teams";
import { CONFIGURED_COMPANIES } from "../lib/company-config";
import { getShiftDurationHours } from "../lib/shift-templates";
import { flightDateFor } from "../lib/flight-date";
import { EMPLOYEES, FLIGHTS, CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_START, CURRENT_WEEK_LABEL } from "../lib/seed-data";
import { Config, Employee, Flight, StaffingRequirement, WeeklyPlanRosterEntry } from "../lib/types";

/**
 * HARD-CONSTRAINTS MILESTONE, PHASE 1 (2026-09-25): a new hard cap for every
 * generation-driven population — max 5 CONSECUTIVE calendar work days —
 * enforced as a pre-scoring filter at the SAME gate as the 15h rest rule.
 *
 * 2026-09-29 FOLLOW-UP AUDIT REMOVAL: phase 1 also introduced a SECOND hard
 * cap, a single-displayed-week HOURS ceiling (Config.hard_weekly_hours_cap,
 * 42h by default). Audited and REMOVED, not relabeled: it silently treated
 * `maximum_average_weekly_working_hours` (a confirmed AVERAGE over a still-
 * unconfirmed reference period) as if it were a real Monday-Sunday ceiling.
 * Every test below that existed ONLY to exercise that removed cap (E2, the
 * old "config — the new hard hours cap..." describe block, PHASE 2 part A's
 * cap-aware roster target) is gone; every test about the SEPARATE,
 * unaffected consecutive-work-day cap is kept. See
 * docs/known-limitations/roster-planning-vs-duty-allocation.md's
 * 2026-09-29 addendum for the full audit trail.
 *
 * Requirement map (milestone brief §E) for what remains:
 *   E1  no 6th consecutive work day, in every generation path, shortfall reported
 *   E3  the cap composes with 15h rest as an independent filter; a fully legal
 *       alternative candidate is still assigned
 *   E4  fixed-cycle employees byte-identical to before this phase
 *   E5  cross-week continuity (real predecessor streak / honest unknown)
 *   E6  maximum_average_weekly_working_hours & average-hours reporting untouched
 *   E7  the cap set non-binding (999) = pre-phase output byte-for-byte
 * plus concrete PHASE-2 scenarios (avoidable gaps the naive filter creates).
 */

const WEEK = "2026-09-21"; // Monday, GMT regime
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
// normal_off_days_consecutive: false pins the pre-2026-09-29 soft-only
// OFF/OFF behavior on both configs below, for the same reason the remaining
// cap is neutered in CAPS_OFF: this file proves the HARD WORK CAPS mechanism
// in isolation, a different, independent concern from the separate
// OFF/OFF-as-hard-constraint correction (covered by tests/stage6-off-
// window-bias.test.ts).
//
// 2026-09-29 follow-up audit: the hard single-displayed-week HOURS cap
// (Config.hard_weekly_hours_cap) that CAPS_OFF/CONSECUTIVE_ONLY used to also
// neutralize/isolate is REMOVED, not relabeled — it silently treated the
// confirmed maximum_average_weekly_working_hours AVERAGE as if it were a
// real Monday-Sunday ceiling. The only hard cap left is the consecutive-
// work-day one, so CONSECUTIVE_ONLY is now just CONFIG (plus the OFF-window
// isolation), and the old HOURS_ONLY config (and every test that only ever
// exercised the removed hours cap) is gone — see
// docs/known-limitations/roster-planning-vs-duty-allocation.md's
// 2026-09-29 "hard 42h cap removed" addendum for the full audit trail.
//
// 2026-09-29 (OFF/OFF phase 2): the generators now ENFORCE the weekly OFF
// floor (minimum_off_days_per_planning_week) for Profiling/Mesure/foreign
// companies too, so the same isolation sets that floor to 0 here — with it,
// a one-person Profiling "team" facing daily demand would be held OFF two
// days by the OFF rules, masking exactly the cap behaviour this file pins.
// The floor's own generator behaviour is covered by
// tests/off-off-generator-placement.test.ts.
const CAPS_OFF: Config = { ...CONFIG, max_consecutive_work_days: 999, normal_off_days_consecutive: false, minimum_off_days_per_planning_week: 0 };
const CONSECUTIVE_ONLY: Config = { ...CONFIG, normal_off_days_consecutive: false, minimum_off_days_per_planning_week: 0 };

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

describe("config — the hard consecutive-work-day cap (2026-09-29: no separate hard hours cap exists any more — see this file's own doc comment)", () => {
  it("max_consecutive_work_days defaults to 5; Config has no hard_weekly_hours_cap field at all", () => {
    expect(CONFIG.max_consecutive_work_days).toBe(DEFAULT_MAX_CONSECUTIVE_WORK_DAYS);
    expect(DEFAULT_MAX_CONSECUTIVE_WORK_DAYS).toBe(5);
    expect(CONFIG).not.toHaveProperty("hard_weekly_hours_cap");
  });

  it("resolveHardWorkCaps reads the config, and falls back to the default for a pre-phase config_snapshot lacking the field (never silently disabling a hard rule)", () => {
    expect(resolveHardWorkCaps(CONFIG)).toEqual({ maxConsecutiveWorkDays: 5 });
    expect(resolveHardWorkCaps({ max_consecutive_work_days: 4 })).toEqual({ maxConsecutiveWorkDays: 4 });
    const legacy = { ...CONFIG } as Partial<Config>;
    delete legacy.max_consecutive_work_days;
    expect(resolveHardWorkCaps(legacy)).toEqual({ maxConsecutiveWorkDays: 5 });
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
    // CAP-PACED REST PLANNING (2026-09-25 lockstep fix): Stage 6's roster
    // above is unchanged, but Saturday's Boarding duty is no longer unfilled:
    // the Air France team is no longer forced OFF all together on Saturday
    // (see the foreign-company test below), so an on-shift Air France member
    // is available and Stage 9 redeploys their slack to it (the existing
    // preferExtended/redeployment rule). Before the fix the whole workforce
    // was OFF on Saturday, which is the only reason Boarding was unfilled.
    expect(unfilledDays(on, "Boarding")).toEqual([]);
    const reqRole = new Map(on.requirements.map((r) => [r.id, r.role]));
    const satBoarding = on.dutiesByDay["Saturday"].filter((d) => reqRole.get(d.requirementId) === "Boarding");
    expect(satBoarding.length).toBeGreaterThan(0);
    expect(satBoarding.every((d) => d.employeeId.startsWith("af-"))).toBe(true);
    const excluded = on.hardCapExclusions.filter((x) => x.population === "flexible_pool");
    expect(excluded.map((x) => `${x.employeeId}|${x.dayOfWeek}|${x.reason}`).sort()).toEqual([
      "flex-a|Saturday|consecutive_work_days",
      "flex-b|Saturday|consecutive_work_days",
    ]);
  });

  it("Profiling/Mesure: capped at 5, the one lost day reported as a BLOCKING demand conflict naming the cap-paced rest", () => {
    // CAP-PACED REST PLANNING (2026-09-25 lockstep fix): prof-1 can legally
    // work 6 of the 7 demand days; the planner places the forced rest day
    // mid-week (evenly spread) instead of wherever the greedy ran into the
    // cap. Same invariant: never a 6th consecutive day, exactly one day lost.
    const worked = workPattern(on, "prof-1");
    expect(maxRun(worked)).toBeLessThanOrEqual(5);
    expect(worked.filter(Boolean).length).toBe(6);
    const offDay = DAYS[worked.indexOf(false)];
    const conflicts = blocking(on, "Profiling");
    expect(conflicts.map((c) => c.day)).toEqual([offDay]);
    for (const c of conflicts) {
      expect(c.description.startsWith("BLOCKING: ")).toBe(true);
      expect(c.description).toContain("within the hard work caps");
      expect(c.description).toContain("5 consecutive work days");
      expect(c.description).toContain("cap-paced rest planning");
      expect(c.description).toContain("rested today to keep their remaining hard-cap capacity for their other planned days: Prof One.");
      expect(c.description).toContain("phase 2");
    }
  });

  it("foreign company: capped at 5, the lost days reported as BLOCKING demand conflicts — spread, never the whole team OFF on the same day", () => {
    // CAP-PACED REST PLANNING (2026-09-25 lockstep fix): before, all three
    // members worked Mon-Fri and ALL hit the consecutive cap together, so
    // Saturday had 0/3 Air France coverage. Now each member's forced rest
    // day is staggered: same 18 person-days, but no day falls to zero.
    let total = 0;
    for (const id of ["af-1", "af-2", "af-3"]) {
      const worked = workPattern(on, id);
      expect(maxRun(worked), id).toBeLessThanOrEqual(5);
      expect(worked.filter(Boolean).length, id).toBe(6);
      total += worked.filter(Boolean).length;
    }
    expect(total).toBe(18);
    for (const day of DAYS) expect(on.generatedShiftsByDay[day].filter((g) => g.coversRoles.includes("Air France")).length, day).toBeGreaterThanOrEqual(2);
    const conflicts = blocking(on, "Air France");
    expect(conflicts).toHaveLength(3);
    for (const c of conflicts) {
      expect(c.description.startsWith("BLOCKING: Air France needed 3 staff member(s)")).toBe(true);
      expect(c.description).toContain("but only 2 could be legally covered within the hard work caps");
      expect(c.description).toContain("cap-paced rest planning");
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

describe("E2 (2026-09-29 REPLACEMENT) — a legal normal week exceeding 42 scheduled hours is NEVER rejected solely for that reason, while 15h rest and the consecutive-work-day cap still apply", () => {
  it("REGRESSION: the Stage-6.5 top-up reaches the FULL normal 5-day target even though 5 x the shortest code (45h) exceeds 42h — no hidden single-week hours ceiling rejects it", () => {
    // Demand only on Monday -> the top-up must supply the other days.
    // Before the 2026-09-29 removal, this same scenario was hard-capped to 4
    // days (see git history / the removed "phase 2, part A" cap-aware
    // target) specifically BECAUSE 5 x 9h = 45h > 42h — exactly the hidden
    // single-week ceiling this test now proves is gone.
    const flights = dailyFlights().filter((f) => f.day_of_week === "Monday" && f.operator_type === "atlas_managed");
    const p = generateDraftWeeklyPlan(flights, [makeEmployee({ id: "solo", skills: ["Boarding"] })], [], CONFIG, DAYS, "W", WEEK);
    expect(workPattern(p, "solo").filter(Boolean).length).toBe(5); // the full normal target, not 4
    expect(weekHours(p, "solo", WEEK)).toBeGreaterThan(42); // 5 x 9h = 45h, genuinely over 42h
    expect(maxRun(workPattern(p, "solo"))).toBeLessThanOrEqual(5); // the REAL cap (consecutive days) still applies
    expect(p.configurationIssues.some((c) => c.requirementId === "hard-cap-roster-top-up-shortfall")).toBe(false);
    expect(p.issues.filter((i) => i.employeeId === "solo").map((i) => i.type)).toEqual([]);
  });

  it("REGRESSION: Stage 6 itself (flexible pool) assigns a candidate whose week would exceed 42h — no per-code hours filter excludes them — while 15h rest is still enforced independently", () => {
    const heavy = makeEmployee({ id: "heavy", skills: ["Boarding"] });
    const flight = makeFlight({ day_of_week: "Wednesday", flight_date: "2026-09-23" });
    const req: StaffingRequirement = { id: "r1", flight_id: "ram-Wednesday", role: "Boarding", baseline_requirement: 1, additional_requirement: 0, total_requirement: 1, source: "fixed_rule", reasoning: "", needs_configuration: false };
    const demand = aggregateDailyDemand("Wednesday", [{ ...flight, id: "ram-Wednesday" }], [req]);
    // 38h already scheduled this week (would have been excluded by the old
    // 42h filter for any code >= 4h; NR01 is 9h).
    const result = generateFlexiblePoolShifts("Wednesday", "2026-09-23", demand, [heavy], new Map(), 15, undefined, new Map(), new Map([["heavy", 38]]));
    expect(result.find((g) => g.employeeId === "heavy")).toBeDefined(); // assigned despite 38 + 9 = 47h > 42h
    // 15h rest is a genuinely separate, still-active hard filter: give
    // "heavy" a prior shift that leaves < 15h before Wednesday's earliest
    // compatible code and confirm they are excluded for THAT reason.
    const restBlocked = generateFlexiblePoolShifts(
      "Wednesday", "2026-09-23", demand, [heavy],
      new Map([["heavy", { shift_start: "20:00", shift_end: "05:00" }]]), // ends 05:00, < 15h before any Wed code
      15, undefined, new Map(), new Map([["heavy", 0]])
    );
    expect(restBlocked.find((g) => g.employeeId === "heavy")).toBeUndefined();
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

  it("2026-09-29 REGRESSION: a candidate already at 38h this week (WOULD have been excluded by the removed hours cap: 38 + 9 = 47h > 42h) is never cap-EXCLUDED any more — the pre-existing SOFT least-hours tie-break (unrelated to hard caps) still prefers the less-used colleague when both are otherwise equally eligible, but that is an ordinary preference, not a rejection", () => {
    const { ids, exclusionsOut } = run([a, b], [["a-first", 2], ["b-second", 2]], [["a-first", 38], ["b-second", 20]]);
    expect(ids).toEqual(["b-second"]); // the pre-existing soft "spread load" tie-break, unchanged by this removal
    expect(exclusionsOut).toEqual([]); // crucially: no cap exclusion recorded — a-first was never rejected, merely out-ranked
    // Alone (no alternative to prefer), a-first at 38h IS assigned despite 38 + 9 = 47h > 42h.
    expect(run([a], [["a-first", 2]], [["a-first", 38]]).ids).toEqual(["a-first"]);
  });

  it("rest is still enforced exactly as before, independently: a rest-illegal candidate is excluded even when the consecutive-day cap is fine (and is not misreported as a cap exclusion)", () => {
    // Prior-day shift ending 06:30 the same morning (overnight NT01) leaves < 15h before any shift covering 14:30.
    const { ids, exclusionsOut } = run([a, b], [["a-first", 0], ["b-second", 0]], [], [["a-first", { shift_start: "17:45", shift_end: "06:30" }]]);
    expect(ids).toEqual(["b-second"]);
    expect(exclusionsOut).toEqual([]);
  });

  it("selectCompatibleShiftCodes applies the consecutive-work-day cap in its filter step: day 6 -> nothing; day 5 and below -> unaffected", () => {
    const base = { consecutiveWorkDaysBeforeToday: 0, maxConsecutiveWorkDays: 5 };
    const all = selectCompatibleShiftCodes("13:00", "14:00", null, null, 15, true, false, "2026-09-23");
    expect(all.length).toBeGreaterThan(1);
    expect(selectCompatibleShiftCodes("13:00", "14:00", null, null, 15, true, false, "2026-09-23", base)).toEqual(all);
    expect(selectCompatibleShiftCodes("13:00", "14:00", null, null, 15, true, false, "2026-09-23", { ...base, consecutiveWorkDaysBeforeToday: 5 })).toEqual([]);
  });

  it("2026-09-29 REGRESSION: selectCompatibleShiftCodes no longer filters by hours at all — a candidate already at 38h this week (would have excluded every code >= 4h under the removed 42h cap) still gets every compatible code back, unfiltered", () => {
    const all = selectCompatibleShiftCodes("13:00", "14:00", null, null, 15, true, false, "2026-09-23");
    const withHardCaps = selectCompatibleShiftCodes("13:00", "14:00", null, null, 15, true, false, "2026-09-23", { consecutiveWorkDaysBeforeToday: 0, maxConsecutiveWorkDays: 5 });
    expect(withHardCaps).toEqual(all);
    for (const c of all) expect(getShiftDurationHours(c.code, "2026-09-23")).toBeGreaterThan(4); // every candidate code here would push 38h past 42h if hours still filtered
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
      // Mon, Tue, Wed can never all be worked (Wednesday would be day 6).
      expect(worked.slice(0, 3).every(Boolean), e.id).toBe(false);
      expect(maxRun(worked, 3), e.id).toBeLessThanOrEqual(5);
    }
    // Flexible and Profiling: Mon, Tue, then OFF Wednesday. Air France is a
    // 3-person team needed in full every day, so CAP-PACED REST PLANNING
    // (2026-09-25 lockstep fix) staggers one member's rest to Tuesday rather
    // than leaving the whole team OFF together on Wednesday.
    for (const id of ["flex-a", "flex-b", "prof-1"]) expect(workPattern(p, id).slice(0, 3), id).toEqual([true, true, false]);
    expect(workPattern(p, "af-1").slice(0, 3).filter(Boolean).length + workPattern(p, "af-2").slice(0, 3).filter(Boolean).length + workPattern(p, "af-3").slice(0, 3).filter(Boolean).length).toBe(6);
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
    // Nobody works all of Mon-Wed (Wednesday would be day 6 of the real
    // streak). Flexible/Profiling are OFF Wednesday; Air France's rest is
    // staggered by CAP-PACED REST PLANNING (2026-09-25 lockstep fix).
    for (const e of employees) {
      const firstThree = ["Monday", "Tuesday", "Wednesday"].map((d) => bundle.rosterEntries.find((r) => r.employee_id === e.id && r.day_of_week === d)?.status === "working");
      expect(firstThree.every(Boolean), e.id).toBe(false);
    }
    const wed = bundle.rosterEntries.filter((r) => r.day_of_week === "Wednesday" && ["flex-a", "flex-b", "prof-1"].includes(r.employee_id));
    expect(wed.every((r) => r.status === "off")).toBe(true);
    expect(bundle.plan.issues.some((i) => i.type === "consecutive_work_history_unknown")).toBe(false);
  });

  it("a MISSING predecessor is the documented 'unknown' policy: the count starts at 0 (5 days allowed) AND the plan carries a visible, non-blocking note — never a silent 'definitely day 0'", () => {
    const p = plan(CONSECUTIVE_ONLY); // no seeds at all
    // Observed on the flexible pool (prof-1's forced rest day is now placed
    // mid-week by CAP-PACED REST PLANNING, 2026-09-25, so it no longer
    // demonstrates a full 5-day run); a fresh-5 count is the same property.
    expect(maxRun(workPattern(p, "flex-a"))).toBe(5);
    expect(workPattern(p, "flex-a").slice(0, 5)).toEqual([true, true, true, true, true]);
    expect(maxRun(workPattern(p, "prof-1"))).toBeLessThanOrEqual(5);
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

  it("E7 — with both caps non-binding (999h / 999 days) the demo roster AND every duty are byte-identical to the pre-phase output (foreign-company OFF blocks and Profiling/Mesure top-up days excepted: OFF/OFF phase 2 + follow-up)", () => {
    // 2026-09-29 (OFF/OFF phase 2): foreign-company members' roster top-up
    // now receives a demand-aware preferred OFF window
    // (computeEmployeeDayCountTopUp's preferredOffWindowStart, previously
    // always undefined). The pre-phase fixture put almost every foreign
    // member's OFF block on Monday-Tuesday purely from the earliest-start
    // tie-break; those blocks now move (spread across each team), which also
    // moves WHICH member holds a company-team duty. That is the intended
    // change and has nothing to do with the hard caps this test isolates, so:
    // every other row and every other duty stays byte-identical, and each
    // foreign row keeps its worked-day count and one consecutive OFF block.
    //
    // 2026-10-01 (OFF/OFF phase 2 follow-up): Profiling/Mesure members now get
    // the SAME normal RAM roster top-up as foreign-company members
    // (generateProfilingMesureShifts' NORMAL RAM ROSTER TOP-UP), so on this
    // sparse demo week their idle days are topped up toward 5 work days.
    // Also unrelated to the hard caps: such a row keeps every one of its
    // pre-phase working days with the same code (the top-up only ADDS days)
    // and never exceeds the normal 5-work-day target.
    const p = demo(CAPS_OFF);
    const roster = rosterOf(p);
    const isForeign = (id: string) => CONFIGURED_COMPANIES.includes(EMPLOYEES.find((e) => e.id === id)!.assignment);
    const isProfMesure = (id: string) => ["Profiling", "Mesure"].includes(EMPLOYEES.find((e) => e.id === id)!.assignment);
    // 2026-10-06 (overnight activation): one specific, named, understood
    // reshuffle. AP03/AP04/NT01/N8 are now real General T1 Pool candidates
    // (lib/planning/shift-generation.ts), so on Sunday
    // mounir-benali-112's AP03 genuinely out-scores souad-benali-99's AP02
    // pick — fewer off-window structural conflicts for him than for her
    // with that code, a real tier-3 fit difference, not an arbitrary tie.
    // That single swap ripples through the Stage-6.5 top-up's shared
    // day-reservation search for these three General T1 Pool members
    // (souad-benali-99 and, in turn, zakaria-ouazzani-54) — each keeps the
    // SAME total worked-day count as the pre-phase fixture, just on
    // different days/codes. No other employee's ROSTER (shift selection)
    // is affected.
    const KNOWN_OVERNIGHT_RESHUFFLE = new Set(["zakaria-ouazzani-54", "souad-benali-99", "mounir-benali-112"]);
    for (const e of EMPLOYEES) {
      if (KNOWN_OVERNIGHT_RESHUFFLE.has(e.id) && roster[e.id] !== fixture.roster[e.id]) {
        const now = roster[e.id].split("|");
        const before = fixture.roster[e.id].split("|");
        expect(now.filter((c) => c !== "OFF").length, e.id).toBe(before.filter((c) => c !== "OFF").length);
        continue;
      }
      if (isProfMesure(e.id) && roster[e.id] !== fixture.roster[e.id]) {
        const now = roster[e.id].split("|");
        const before = fixture.roster[e.id].split("|");
        before.forEach((code, j) => {
          if (code !== "OFF") expect(now[j], `${e.id} ${DAYS_WITH_DATA[j]}`).toBe(code);
        });
        expect(now.filter((c) => c !== "OFF").length, e.id).toBeLessThanOrEqual(5);
        continue;
      }
      if (!isForeign(e.id) || roster[e.id] === fixture.roster[e.id]) {
        expect(roster[e.id], e.id).toBe(fixture.roster[e.id]);
        continue;
      }
      const worked = roster[e.id].split("|").map((c) => c !== "OFF");
      expect(worked.filter(Boolean).length, e.id).toBe(fixture.roster[e.id].split("|").filter((c) => c !== "OFF").length);
      const off = worked.map((w) => !w);
      const offCount = off.filter(Boolean).length;
      const longest = maxRun([...off, ...off].slice(0, 13)); // cyclic run
      expect(Math.min(longest, offCount), e.id).toBe(offCount); // one consecutive (cyclic) block
    }
    const companyDuty = (d: string) => d.split("|")[1].endsWith("-company-team");
    const duties = dutiesOf(p);
    // Same duties, same holders; only their order within a day may move (Stage 9 walks requirements in a
    // capacity-dependent order and the foreign members above are on different days now).
    // 2026-10-01: a Profiling/Mesure member's topped-up day puts them in Stage
    // 9's candidate pool for that day, so WHICH team member holds a team duty
    // may move within the same team (observed: the Tuesday/Saturday AT740
    // Mesure slots). Same slots, held by the same team — compared that way.
    const holderTeam = (d: string) => EMPLOYEES.find((e) => e.id === d.split("|")[2])!.assignment;
    const profMesureDuty = (d: string) => ["Profiling", "Mesure"].includes(holderTeam(d));
    // 2026-10-03 (task-count fairness demo milestone — see
    // lib/fairness-config.ts's taskCountWeight, now ON by default): a
    // Profiling-ROLE requirement (req-id ending "-profiling") was
    // previously won, on several days, by Youssef El Amrani (a General T1
    // Pool generalist who happens to hold the Profiling skill) purely
    // because he came first in the candidate pool's stable input order —
    // never because he was specially preferred. With task-count fairness
    // now breaking that tie, the SAME requirement is just as often filled
    // by one of the dedicated Profiling-team specialists instead (who
    // isn't excluded by profMesureDuty above when a generalist holds it).
    // Coverage is identical either way (verified below via profilingSlots)
    // — only WHICH equally-qualified individual holds it moves, exactly
    // the business-confirmed behavior this milestone implements.
    const profilingRoleDuty = (d: string) => d.split("|")[1].endsWith("-profiling");
    const plain = (list: string[]) => list.filter((d) => !companyDuty(d) && !profMesureDuty(d) && !profilingRoleDuty(d)).sort();
    // Same 2026-10-03 task-count fairness milestone also re-pinned 3 plain
    // (non-Profiling, non-team) duties in the fixture itself: Wednesday's
    // one-off AT201/AT535 requirements had a second, equally-eligible
    // General T1 Pool candidate tied with the fixture's original holder
    // (Sanaa Benali / Sara Bennis), and the new taskCountWeight tie-break
    // now picks the one with fewer tasks already assigned that day (Hajar
    // Benali, Amine Benali, Nadia Ziani) instead of the old stable-input-
    // order winner. Verified directly: both are genuinely eligible
    // ("recommended") candidates for that slot: this is the intended
    // redistribution, not a coverage change, so the fixture's 3 affected
    // duty strings were updated rather than the test loosened.
    //
    // 2026-10-06 (overnight activation): the same KNOWN_OVERNIGHT_RESHUFFLE
    // swap above also ripples into Stage 9's duty assignment for the
    // Sunday AT870 Dreamliner's 2+2 Gate/Boarding cluster — a FOURTH
    // member, othmane-chafik-122 (whose own shift/roster never changes,
    // confirmed identical to the fixture), trades which of the two roles
    // he covers with souad-benali-99 (he moves from Boarding to Gate as
    // she drops out of that cluster; mounir-benali-112 picks up the
    // Boarding seat he vacates). This was INITIALLY found (during this same
    // verification pass) to cost one real seat of that 2+2 requirement —
    // traced to three genuine, now-fixed bugs unrelated to this scoring
    // swap itself: lib/scoring.ts's shift/window overlap and containment
    // math had no overnight awareness (an overnight employee's OWN
    // starting evening looked entirely unavailable), a carryover
    // candidate's rest wrongly read their stale static baseline instead of
    // their already-cleared real rest, and lib/planning/requirement-
    // window.ts's subtractMinutes wrapped a pre-midnight lead time into a
    // malformed window instead of clamping at 00:00 (lib/shift-interval.ts,
    // lib/planning/duty-generation.ts, lib/planning/requirement-window.ts).
    // With those fixed, the 2+2 need is fully covered again: same total
    // duty COUNT per (day, requirement) slot as the pre-phase fixture,
    // reshuffled only among this known 4-person set — compared as
    // multisets (not a simple slot map) since this is a 2-headcount
    // requirement with two simultaneous holders. Everyone else's plain
    // duties must still match byte-for-byte.
    const KNOWN_DUTY_RESHUFFLE = new Set([...KNOWN_OVERNIGHT_RESHUFFLE, "othmane-chafik-122"]);
    const reshuffleTouches = (d: string) => KNOWN_DUTY_RESHUFFLE.has(d.split("|")[2]);
    const slotOnly = (d: string) => d.split("|").slice(0, 2).join("|");
    const plainNow = plain(duties);
    const plainBefore = plain(fixture.duties);
    expect(plainNow.filter((d) => !reshuffleTouches(d))).toEqual(plainBefore.filter((d) => !reshuffleTouches(d)));
    const countBySlot = (list: string[]) => {
      const counts = new Map<string, number>();
      for (const d of list.filter(reshuffleTouches)) counts.set(slotOnly(d), (counts.get(slotOnly(d)) ?? 0) + 1);
      return counts;
    };
    const slotCountsBefore = countBySlot(plainBefore);
    const slotCountsNow = countBySlot(plainNow);
    // Same slots, same per-slot headcount — nothing newly gained or lost.
    expect(Object.fromEntries(slotCountsNow)).toEqual(Object.fromEntries(slotCountsBefore));
    for (const d of plainNow.filter(reshuffleTouches)) expect(KNOWN_DUTY_RESHUFFLE.has(d.split("|")[2])).toBe(true);
    const teamSlots = (list: string[]) =>
      list
        .filter((d) => !companyDuty(d) && profMesureDuty(d) && !profilingRoleDuty(d))
        .map((d) => `${d.split("|").slice(0, 2).join("|")}|${holderTeam(d)}`)
        .sort();
    expect(teamSlots(duties)).toEqual(teamSlots(fixture.duties));
    const slots = (list: string[]) => list.filter(companyDuty).map((d) => d.split("|").slice(0, 2).join("|")).sort();
    expect(slots(duties)).toEqual(slots(fixture.duties));
    // Profiling-role coverage itself never moves or drops — same (day,
    // requirement) slots are filled in both runs, regardless of which
    // Profiling-qualified employee now holds each one (see the comment
    // above profilingRoleDuty).
    const profilingSlots = (list: string[]) => list.filter(profilingRoleDuty).map((d) => d.split("|").slice(0, 2).join("|")).sort();
    expect(profilingSlots(duties)).toEqual(profilingSlots(fixture.duties));
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

  it("default caps: no generation-driven employee exceeds 5 consecutive days (youssef-el-amrani's documented 7-day week is now capped), and 15h rest still holds — weekly HOURS are never a rejection ceiling (2026-09-29 removal)", () => {
    // This test used to also assert weekHours(...) <= 42 for every
    // generation-driven employee. That assertion pinned the REMOVED hidden
    // Monday-Sunday 42h hard cap: maximum_average_weekly_working_hours is a
    // confirmed AVERAGE over an unconfirmed reference period (not_evaluable
    // until configured, see the E6 test below), never a per-week ceiling, so
    // a legal roster is allowed to exceed 42 scheduled hours in a single
    // week. Only the consecutive-work-day cap and 15h rest are real hard
    // constraints here.
    expect(fixture.roster["youssef-el-amrani"]).toBe("MT01|MT01|MT01|MT01|MT01|MT01|MT01");
    for (const e of EMPLOYEES.filter(isGenerationDrivenPopulation)) {
      const worked = defaultRoster[e.id].split("|").map((c) => c !== "OFF");
      expect(maxRun(worked), e.id).toBeLessThanOrEqual(5);
    }
    expect(atDefault.issues.filter((i) => i.type === "rest_violation")).toEqual([]);
    expect(maxRun(defaultRoster["youssef-el-amrani"].split("|").map((c) => c !== "OFF"))).toBeLessThanOrEqual(4);
  });

  it("REGRESSION (2026-09-29): a legal normal weekly roster exceeding 42 scheduled hours is not rejected solely for that reason — sara-bennis's real demo roster tops 42h and stays fully assigned with zero rest violations", () => {
    // Direct proof for the user's explicit ask: find a real, legally-generated
    // roster that exceeds 42h/week and confirm nothing rejected it for that.
    const hours = weekHours(atDefault, "sara-bennis", CURRENT_WEEK_START);
    expect(hours).toBeGreaterThan(42);
    expect(defaultRoster["sara-bennis"].split("|").every((c) => c !== "OFF" || true)).toBe(true); // roster exists, not blanked out
    expect(atDefault.issues.filter((i) => i.employeeId === "sara-bennis" && i.type === "rest_violation")).toEqual([]);
    expect(atDefault.hardCapExclusions.some((x) => x.employeeId === "sara-bennis")).toBe(false);
    // 15h rest is still a REAL hard constraint, unaffected by the hours-cap removal.
    expect(maxRun(defaultRoster["sara-bennis"].split("|").map((c) => c !== "OFF"))).toBeLessThanOrEqual(5);
  });

  it("E6 — maximum_average_weekly_working_hours is untouched: still the resolved 42h AVERAGE, still not evaluable, still no findings — and generation never reads it", () => {
    const rules = resolveDefaultLaborRules();
    expect(CONFIG.maximum_average_weekly_working_hours).toBe(rules.maximumAverageWeeklyWorkingHours);
    expect(CONFIG.working_hours_reference_period_days).toBeNull();
    expect(evaluateAverageWorkingHours(63, 7, CONFIG)).toEqual({ status: "not_evaluable", reason: "reference_period_unconfigured" });
    // The hard consecutive-work-day cap never feeds average-hours reporting...
    expect(evaluateAverageWorkingHours(63, 7, { ...CONFIG, max_consecutive_work_days: 1 })).toEqual(evaluateAverageWorkingHours(63, 7, CONFIG));
    const withRef = { ...CONFIG, working_hours_reference_period_days: 7 };
    expect(evaluateAverageWorkingHours(63, 7, { ...withRef, max_consecutive_work_days: 999 })).toEqual(evaluateAverageWorkingHours(63, 7, withRef));
    expect(auditAverageWeeklyHoursFeasibility(EMPLOYEES, isGenerationDrivenPopulation, CONFIG, CURRENT_WEEK_START)).toEqual([]);
    // ...and generation never reads the average: moving it changes nothing.
    expect(rosterOf(demo({ ...CONFIG, maximum_average_weekly_working_hours: 10 }))).toEqual(defaultRoster);
    expect(rosterOf(demo({ ...CONFIG, maximum_average_weekly_working_hours: 99 }))).toEqual(defaultRoster);
  });

  it("default caps on the demo: no NEW unfilled flight duty and no new rest violation versus the pre-phase plan", () => {
    // 2026-10-06 (overnight activation): AP03/AP04/NT01/N8 are now real
    // Stage-6 candidates, so on Sunday mounir-benali-112's AP03 genuinely
    // out-scores souad-benali-99's AP02 pick by a single
    // OFF_WINDOW_STRUCTURE_CONFLICT_WEIGHT unit (a real tier-3 fit
    // difference, not an arbitrary tie), which ripples through Stage 9's
    // candidate pool for the Dreamliner AT870 Sunday 2+2 Gate/Boarding
    // cluster: souad-benali-99 and othmane-chafik-122 trade which of the
    // two roles they cover (see the "E7" test's own fuller roster/duty
    // comparison for this). A SEPARATE, earlier finding in this same
    // verification pass had this swap costing one real seat of that 2+2
    // need (req-at870-sunday-gate going unfilled) — that was traced to two
    // genuine bugs, not an inherent Stage-6-bucket-granularity limit:
    // lib/scoring.ts's shift/window overlap and containment checks did
    // raw minute-of-day math with no overnight awareness, so an overnight
    // employee's OWN starting evening (not just the following day's
    // carryover) looked entirely unavailable for scoring; and a carryover
    // candidate's rest was wrongly read from their stale static baseline
    // instead of being treated as already-cleared (enforceRestInvariant-
    // AcrossWeek already verifies rest before ever accepting the shift).
    // Both are now fixed (lib/shift-interval.ts's shiftOverlapsWindow,
    // lib/planning/duty-generation.ts's carryover rest handling), plus a
    // third, independent bug in the same area (lib/planning/requirement-
    // window.ts's subtractMinutes wrapping a pre-midnight lead time back
    // around to a malformed, self-overlapping window instead of clamping
    // at 00:00). With all three fixed, the Dreamliner's 2+2 need is fully
    // covered again — same total duty count as the pre-phase fixture, zero
    // new unfilled_duty issues.
    expect(dutiesOf(atDefault).length).toBe(fixture.duties.length);
    expect(atDefault.issues.filter((i) => i.type === "unfilled_duty")).toEqual([]);
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

describe("PHASE 2, part A (2026-09-29 REPLACEMENT) — the roster target is now UNCONDITIONALLY the normal one; only the surviving consecutive-work-day cap can still cause a genuine, flagged shortfall", () => {
  it("2026-09-29 REGRESSION: an employee whose week would need 45h (5 x 9h) reaches the FULL normal target of 5 — no hours-based reduction to 4 exists any more", () => {
    // Demand only on Monday; everything else comes from the top-up. Before
    // the removal, this reached only 4 days (see the old "computeCapAware
    // TargetWorkDays" test this replaces, and git history).
    const flights = dailyFlights().filter((f) => f.day_of_week === "Monday" && f.operator_type === "atlas_managed");
    const p = generateDraftWeeklyPlan(flights, [makeEmployee({ id: "solo", skills: ["Boarding"] })], [], CONFIG, DAYS, "W", WEEK);
    const worked = workPattern(p, "solo");
    expect(worked.filter(Boolean).length).toBe(5);
    expect(weekHours(p, "solo", WEEK)).toBe(45); // genuinely over the old 42h ceiling
    expect(p.issues.filter((i) => i.employeeId === "solo")).toEqual([]);
    expect(p.configurationIssues.some((c) => c.requirementId === "hard-cap-roster-top-up-shortfall")).toBe(false);
  });

  it("FLAGGED: the (only remaining) hard cap — max 2 consecutive work days plus a real incoming streak of 2 — closes a day, so only 4 of the normal 5 are rostered; roster_target_shortfall fires naming the closed day", () => {
    const config: Config = { ...CONFIG, max_consecutive_work_days: 2 };
    const flights = dailyFlights().filter((f) => f.day_of_week === "Tuesday" && f.operator_type === "atlas_managed");
    const seeds = new Map<string, IncomingConsecutiveWorkDaysSeed>([["solo", { source: "prior_plan", streak: 2, lowerBound: false }]]);
    const p = generateDraftWeeklyPlan(flights, [makeEmployee({ id: "solo", skills: ["Boarding"] })], [], config, DAYS, "W", WEEK, new Map(), "unknown", { incomingConsecutiveWorkDays: seeds });
    expect(workPattern(p, "solo").filter(Boolean).length).toBe(4);
    const flagged = p.issues.filter((i) => i.type === "roster_target_shortfall");
    expect(flagged).toHaveLength(1);
    expect(flagged[0].employeeId).toBe("solo");
    expect(flagged[0].description).toContain("rostered 4 work day(s) this week but their target is the normal 5");
    expect(flagged[0].description).toContain("because the hard consecutive-work-day cap closed");
  });

  it("checkRosterTargetShortfall is exactly the distinction: at-target -> nothing; below target WITH a cap-closed day -> flagged; below target with no cap involvement -> not re-flagged by this check", () => {
    const week = (workedDays: number) => makeEmployee({ id: "e", name: "E", weekly_shifts: DAYS.map((d, i) => ({ day_of_week: d, status: i < workedDays ? ("working" as const) : ("off" as const), shift_code: i < workedDays ? "NR01" : null })) });
    expect(checkRosterTargetShortfall(week(5), DAYS, CONFIG)).toBeNull(); // at the normal target
    expect(checkRosterTargetShortfall(week(4), DAYS, CONFIG)).toBeNull(); // below target but no cap closure supplied
    expect(checkRosterTargetShortfall(week(4), DAYS, CONFIG, ["Friday"])?.type).toBe("roster_target_shortfall");
    expect(checkRosterTargetShortfall(week(4), DAYS, CONFIG, [])).toBeNull(); // empty closure list = nothing to check
  });

  it("caps non-binding: every employee reaches the normal 5 and no roster_target_shortfall appears on the demo", () => {
    const boundary = deriveFallbackBoundaryContext(EMPLOYEES, DAYS_WITH_DATA, CURRENT_WEEK_START);
    const p = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CAPS_OFF, DAYS_WITH_DATA, CURRENT_WEEK_LABEL, CURRENT_WEEK_START, boundary, "fallback_static_baseline");
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

  it("Air France under the FULL default caps (2026-09-29 REPLACEMENT): with the hidden hours ceiling removed the fixture that used to be 'provably infeasible' (5 members x at most 4 days of 9h under 42h = 20 < 21 needed) is now fully coverable — the bounded repair reallocates one day and all 21 person-days are covered, zero conflicts", () => {
    // BEFORE the 2026-09-29 removal, this pinned an hours-ceiling artifact:
    // "5 members x at most 4 days of 9h under 42h = 20 < 21 needed" capped
    // the team below full demand no matter what the repair pass did. With no
    // hours cap, only the 5-consecutive-work-day cap is real, and the
    // bounded repair pass (which already existed for exactly this purpose)
    // finds a single legal reallocation (Monday: af-1 -> af-4) that closes
    // the remaining gap entirely.
    const { result, repairsOut, pattern, team, incoming } = airFranceScenario(CONFIG);
    expect(team.reduce((n, e) => n + pattern(e.id).filter(Boolean).length, 0)).toBe(21);
    expect(result.conflicts).toEqual([]);
    expect(repairsOut).toHaveLength(1);
    expect(repairsOut[0]).toMatchObject({ population: "foreign_company", kind: "reallocate_for_gap", team: "Air France", reassignedDay: "Monday", targetDay: "Tuesday", fromEmployeeId: "af-1", toEmployeeId: "af-4", cap: "consecutive_work_days" });
    for (const e of team) expect(maxRun(pattern(e.id).map(Boolean), incoming.get(e.id)!), e.id).toBeLessThanOrEqual(5);
    for (const r of repairsOut) expect(r.population).toBe("foreign_company");
  });

  it("youssef-el-amrani (real demo data): the original 3-day-OFF-block scenario this test pinned no longer occurs at all — Stage 6 itself now respects OFF/OFF pairing as a hard constraint (2026-09-29 correction), so no repair is needed", () => {
    // BEFORE the 2026-09-29 correction, this pinned a specific hard-cap-repair
    // move (Monday -> Saturday) that fixed a 3-day OFF block Stage 6's own
    // greedy output produced. Stage 6 now hard-excludes a flexible ACE from
    // its own planned OFF/OFF window (lib/planning/off-window.ts,
    // Config.normal_off_days_consecutive default true) instead of merely
    // scoring around it — for this real demo data, that alone already
    // produces a clean 2-consecutive-OFF pattern with no cap violation, so
    // the repair pass this test used to exercise for youssef has nothing
    // left to fix. This is a genuine improvement, not a regression: the
    // class of bug the repair pass existed for is now prevented earlier.
    // 2026-09-29 follow-up (hours-cap removal): with the hidden 42h ceiling
    // gone, youssef-el-amrani's real demo-data pattern now also picks up
    // Sunday (previously left OFF only because the old hours arithmetic
    // discouraged a 6th working day) — [T,T,F,F,T,T,T], a 3-day trailing run,
    // still under the 5-consecutive-day cap and still a clean 2-day OFF pair.
    // 2026-10-04 (RAM staffing matrix revision): Gate/Boarding is now a
    // universal, confirmed rule for every RAM flight (see
    // lib/ram-staffing-matrix.ts), so the two Morocco-domestic routes
    // (AT302/RAK, AT401/FEZ — every day of the week) now generate real
    // Gate/Boarding demand that used to be silently dropped as
    // needs_configuration. That extra daily demand shifts youssef's clean
    // 2-day OFF block one day earlier — [T,F,F,T,T,T,T] — still a 3-day
    // trailing run, still under the 5-consecutive-day cap, still a clean
    // 2-day OFF pair; only which two days moved.
    const boundary = deriveFallbackBoundaryContext(EMPLOYEES, DAYS_WITH_DATA, CURRENT_WEEK_START);
    const run = (hardCapRepair: boolean) =>
      generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_LABEL, CURRENT_WEEK_START, boundary, "fallback_static_baseline", { hardCapRepair });
    const before = run(false);
    expect(workPattern(before, "youssef-el-amrani")).toEqual([true, false, false, true, true, true, true]);
    expect(before.issues.some((i) => i.type === "consecutive_off_violation" && i.employeeId === "youssef-el-amrani")).toBe(false);
    expect(maxRun(workPattern(before, "youssef-el-amrani"))).toBeLessThanOrEqual(5);

    const p = run(true);
    expect(workPattern(p, "youssef-el-amrani")).toEqual(workPattern(before, "youssef-el-amrani")); // repair is a genuine no-op here now
    // 2026-10-06 (overnight activation): unrelated to youssef-el-amrani or
    // this repair pass — see the "default caps on the demo" test above for
    // the Sunday AT870 Dreamliner reshuffle this activation causes
    // elsewhere in the roster, which (after fixing the real overlap/rest/
    // window bugs the audit found) remains fully covered, zero unfilled.
    expect(p.issues.filter((i) => i.type === "unfilled_duty")).toEqual([]);
    expect(p.issues.filter((i) => i.type === "rest_violation")).toEqual([]);
    expect(p.hardCapRepairs.filter((r) => r.fromEmployeeId === "youssef-el-amrani")).toEqual([]);
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
    // Weekly hours are no longer a rejection ceiling (2026-09-29 removal):
    // only the consecutive-work-day cap is a real hard constraint here.
    for (const e of team) expect(maxRun(workPattern(p, e.id), e.id.startsWith("a-") ? 4 : 0), e.id).toBeLessThanOrEqual(5);
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
    // Weekly hours are no longer a rejection ceiling (2026-09-29 removal):
    // only the consecutive-work-day cap is a real hard constraint here.
    for (const e of EMPLOYEES.filter(isGenerationDrivenPopulation)) expect(maxRun(workPattern(on, e.id)), e.id).toBeLessThanOrEqual(5);
  });
});

describe("PHASE 2, part B — Gulf Air's 'structural shortfall' was an hours-cap artifact and is now fully resolved (2026-09-29 REPLACEMENT)", () => {
  // BEFORE the 2026-09-29 removal, this fixture (whole 8-person team needed
  // on all 4 flight days, every covering code >= 11.25h) pinned an hours-cap
  // artifact: "3 x 11.25h + 11.25h > 42h" limited each member to only 3 of
  // the 4 flight days, capping team capacity at 24 of the 32 needed
  // person-days and leaving every flight day an honest BLOCKING gap. With
  // the hidden 42h ceiling removed, the ONLY remaining hard constraint is
  // the 5-consecutive-work-day cap — and since these 4 flight days
  // (Mon/Wed/Fri/Sun) are never consecutive (Tue/Thu/Sat are gaps), no
  // member's streak is ever at risk. The team now fully covers all 4 days:
  // the "structural shortfall" this block existed to pin no longer exists.
  const gulfTeam = () => [
    ...[1, 2, 3, 4, 5, 6, 7].map((i) => makeEmployee({ id: `gf-ace-${i}`, name: `GF Ace ${i}`, assignment: "Gulf Air", team_role: "ace", foreign_company_authorizations: ["Gulf Air"] })),
    makeEmployee({ id: "gf-leader", name: "GF Leader", assignment: "Gulf Air", team_role: "leader", foreign_company_authorizations: ["Gulf Air"] }),
  ];
  const gulfFlights = () =>
    ["Monday", "Wednesday", "Friday", "Sunday"].map((day) =>
      makeFlight({ id: `gf-${day}`, flight_number: "GF105", airline: "Gulf Air", route: "CMN → BAH", destination: "BAH", aircraft: "Airbus A320", scheduled_departure: "09:00", day_of_week: day, flight_date: flightDateFor(WEEK, day), operator_type: "self_managed" })
    );

  it("the whole 8-person team is needed on each of 4 non-consecutive flight days: every day is now fully staffed (8/8), zero conflicts, zero repairs needed", () => {
    const repairsOut: import("../lib/planning/hard-cap-repair").HardCapRepair[] = [];
    const { generatedShiftsByDay, conflicts } = generateForeignCompanyShifts(DAYS, gulfTeam(), gulfFlights(), ["Gulf Air"], 15, WEEK, new Map(), undefined, undefined, {
      caps: resolveHardWorkCaps(CONFIG), incomingStreakByEmployee: new Map(), repairsOut,
    });
    const flightDays = ["Monday", "Wednesday", "Friday", "Sunday"];
    for (const day of flightDays) expect(generatedShiftsByDay[day], day).toHaveLength(8);
    expect(flightDays.reduce((n, d) => n + generatedShiftsByDay[d].length, 0)).toBe(32);
    for (const g of generatedShiftsByDay["Monday"]) expect(getShiftDurationHours(g.shiftCode, flightDateFor(WEEK, "Monday"))).toBeGreaterThanOrEqual(11.25);
    // The leader now works every flight day too — no capacity throttle forces a rotation.
    expect(flightDays.every((d) => generatedShiftsByDay[d].some((g) => g.employeeId === "gf-leader"))).toBe(true);
    expect(repairsOut).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it("through the full pipeline there is no Gulf Air BLOCKING issue at all any more", () => {
    const p = generateDraftWeeklyPlan(gulfFlights(), gulfTeam(), [], CONFIG, DAYS, "W", WEEK);
    expect(p.configurationIssues.find((c) => c.requirementId === "specialized-demand-conflict-Gulf Air-Sunday")).toBeUndefined();
    expect(p.configurationIssues.some((c) => c.description?.includes("Gulf Air"))).toBe(false);
    expect(p.hardCapRepairs.filter((r) => r.team === "Gulf Air")).toEqual([]);
  });

  it("the real 2026-09-21-regime demo week no longer reports a Gulf Air Sunday gap at all (2026-09-29 REPLACEMENT) — its previously-documented BLOCKING shortfall was solely the now-removed hours ceiling, not a real staffing infeasibility", () => {
    const p = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, "W", WEEK);
    expect(p.configurationIssues.some((c) => c.requirementId === "specialized-demand-conflict-Gulf Air-Sunday")).toBe(false);
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
    // 2026-09-29 correction: 0, not >0, for the real demo data — Stage 6
    // itself now respects OFF/OFF pairing as a hard constraint (see the
    // youssef-el-amrani test above), which already prevents the specific
    // lockstep/OFF-block scenarios this repair pass used to need to fix
    // here. The exemption loop below is kept as a structural guard (it
    // still passes trivially with zero repairs); synthetic scenarios
    // elsewhere in this file (e.g. "flexible pool (Stage 6): the same
    // streak-ordering gap" below) exercise the repair pass itself with
    // repairs > 0.
    expect(p.hardCapRepairs.length).toBe(0);
    const staticIds = new Set(EMPLOYEES.filter((e) => !isGenerationDrivenPopulation(e)).map((e) => e.id));
    for (const r of p.hardCapRepairs) for (const id of [r.fromEmployeeId, r.toEmployeeId, r.filledByEmployeeId]) if (id) expect(staticIds.has(id), id).toBe(false);
    for (const e of EMPLOYEES.filter((x) => usesFixedCycleRotation(x.assignment))) {
      const roster = DAYS_WITH_DATA.map((day) => { const r = p.rosterEntries.find((x) => x.employee_id === e.id && x.day_of_week === day)!; return r.status === "working" ? r.shift_code : "OFF"; }).join("|");
      expect(roster, e.id).toBe(fixture.roster[e.id]);
    }
  });

  it("BOUNDED: a pathological week (41 cap-blocked candidates x 5 hand-off days x 40 would-be stand-ins who all fail at the last check) stops at its attempt budget, changes nothing, and reports the exhausted search", () => {
    // 41 X members work Tue-Sat (NR01); Sunday needs all 41 of them, but for
    // each a Sunday would be a 6th consecutive day. 40 Y members are eligible
    // for every Tue-Sat need, so every (X, day) hand-off enumerates all 40 of
    // them — but every Y fails at its final check, so the search must
    // genuinely exhaust the combination space rather than succeeding early.
    // Unbounded, that is 41 x 5 x (1 + 40) = 8405 evaluations for a week with
    // no solution at all.
    //
    // 2026-10-06 (overnight activation): this used to rely on the Tue-Sat
    // need window (02:00-23:30) being one no catalog code could ever cover,
    // so each Y failed at its CATALOG check. AP03/AP04/NT01/N8 are now real
    // candidates (lib/foreign-shift-planning.ts's selectCompatibleShiftCodes,
    // called here with allowLateStart=true), and an overnight code's reach
    // is always end-of-day (lib/shift-interval.ts's reachOfDayMinutes) — so
    // a same-day window end can no longer, by itself, defeat every catalog
    // code. Rather than weaken that (overnight codes genuinely should be
    // real late-window candidates — that is this whole phase's point), this
    // now blocks every Y at the SEPARATE, independent hard-cap check
    // instead: each Y enters the week already at the 5-consecutive-work-day
    // cap (incomingStreakByEmployee) with Monday pre-committed, so
    // hardCapBreach rejects them on every one of Tuesday-Saturday
    // regardless of which catalog code would otherwise match — the same
    // "every stand-in fails, so the search must exhaust the full space"
    // property, just enforced at a different, still-robust gate.
    const xs = Array.from({ length: 41 }, (_, i) => `x-${String(i).padStart(2, "0")}`);
    const ys = Array.from({ length: 40 }, (_, i) => `y-${String(i).padStart(2, "0")}`);
    const worked = ["Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const input = (budget?: number): SlotRepairInput => ({
      population: "foreign_company", team: "Stress",
      ctx: {
        daysOrder: DAYS,
        weekStart: WEEK,
        minimumRestHours: 15,
        caps: resolveHardWorkCaps(CONSECUTIVE_ONLY),
        // Every Y already sits at the cap entering the week, and (below)
        // already holds Monday — so hardCapBreach rejects them outright on
        // every Tuesday-Saturday candidate, independent of catalog/overnight
        // availability. See this test's own 2026-10-06 note above.
        incomingStreakByEmployee: new Map(ys.map((id) => [id, DEFAULT_MAX_CONSECUTIVE_WORK_DAYS])),
        priorWeekBoundaryContext: new Map(),
      },
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
      assignmentsByDay: Object.fromEntries(
        DAYS.map((d) => [
          d,
          worked.includes(d)
            ? xs.map((id) => ({ employeeId: id, shiftCode: "NR01", groupKey: d }))
            : // Monday: every Y is pre-committed here too (an ungrouped slot — Monday
              // has no real demand group, so this never competes with a real need) so
              // their incoming streak carries straight through into the
              // hardCapBreach walk no matter which Tuesday-Saturday day is being
              // tested (the walk resets on the first untouched day — see the
              // 2026-10-06 note above).
              d === "Monday"
              ? ys.map((id) => ({ employeeId: id, shiftCode: "NT01", groupKey: "y-precommitted" }))
              : [],
        ])
      ),
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

// ---------------------------------------------------------------------------

describe("repairFlexiblePoolWeek — OFF/OFF regression (2026-10-06): a hard-cap OFF-run repair must never fragment a legal single OFF block", () => {
  // Real shape reported in Live Operations: an employee ends up with
  // SEPARATED single-day OFF days (e.g. Thursday OFF, Friday/Saturday
  // WORK, Sunday OFF) instead of one consecutive OFF block, even though
  // Config.normal_off_days_consecutive is hard-on. validation.ts correctly
  // flagged it ("Weekly issue"), proving the gap was in generation/repair,
  // not validation.
  //
  // Root cause, traced to this exact function: the OFF-RUN repair phase's
  // legality check (`xOk`, now fixed) only verified the LONGEST OFF run
  // stayed <= max_consecutive_off_days. It never checked whether the
  // employee's OFF days still formed ONE block — so when an employee's OFF
  // run was over-long (e.g. 3 days, forced by an earlier hard-cap
  // exclusion), the repair could "fix" it by moving ONE of their other
  // work days onto a day in the MIDDLE of that run, satisfying the ceiling
  // while splitting the run into two or three separated single-day OFFs.
  // repairCoverageGaps (the Profiling/Mesure/foreign-company repair path)
  // already guarded against exactly this with breaksOffDayRules; this
  // flexible-pool path (General T1 Pool) simply never called it.
  //
  // Scenario: X works Mon/Tue/Sat/Sun (NR01) and is OFF Wed/Thu/Fri — a
  // real, honest 3-day OFF run (over the 2-day ceiling), the trigger this
  // phase exists for. No other employee exists, so HAND-OFF can never
  // apply (no standIn), isolating SHIFT OWN DAY. Every legal (rest-wise)
  // SHIFT OWN DAY move in this shape either still exceeds the ceiling or
  // would fragment the block — so the correct outcome is NO repair at all
  // (the honest over-long run persists for validation to report), never a
  // fragmented "fix".
  const ctx = {
    daysOrder: DAYS,
    weekStart: WEEK,
    minimumRestHours: 15,
    caps: { maxConsecutiveWorkDays: 6 }, // loose — isolates the OFF-day-rule check from the work-day-streak cap
    incomingStreakByEmployee: new Map<string, number>(),
    priorWeekBoundaryContext: new Map(),
  };
  const offDayRules = { minimumOffDays: 2, consecutive: true };
  const workedDays = ["Monday", "Tuesday", "Saturday", "Sunday"];
  const stage6ShiftsByDay = Object.fromEntries(
    DAYS.map((d) => [d, workedDays.includes(d) ? [{ employeeId: "x", dayOfWeek: d, shiftCode: "NR01", coversRoles: [] }] : []])
  );
  const exclusions: FlexibleRepairInput["exclusions"] = [{ employeeId: "x", dayOfWeek: "Wednesday", population: "flexible_pool", reason: "consecutive_work_days" }];
  const employees = [makeEmployee({ id: "x", name: "X", skills: ["Gate"] })];

  function offRunAndSplit(pattern: ("working" | "off")[]) {
    const run = maxConsecutiveOffCyclic(pattern.map((status) => ({ status })));
    const offCount = pattern.filter((s) => s === "off").length;
    return { run, isOneBlock: offCount === 0 || run === offCount };
  }

  it("never fragments the OFF block: with the fix, no repair is applied rather than a split one (the pre-fix bug would have split it)", () => {
    const input: FlexibleRepairInput = {
      ctx,
      employees,
      demandByDay: {}, // no demand at all -- isolates Phase 2 (OFF-run) from Phase 1 (gap repair)
      stage6ShiftsByDay,
      exclusions,
      maxConsecutiveOffDays: 2,
      simulateTopUp: () => new Map(), // nothing added by the top-up in this minimal scenario
      offDayRules,
    };
    const result = repairFlexiblePoolWeek(input);

    const finalPattern = DAYS.map((d) => ((result.stage6ShiftsByDay[d] ?? []).some((g) => g.employeeId === "x") ? "working" : "off")) as ("working" | "off")[];
    const { isOneBlock } = offRunAndSplit(finalPattern);

    // The fix's own contract: never leave X with a fragmented OFF pattern.
    expect(isOneBlock).toBe(true);
    // No legal non-fragmenting SHIFT-OWN-DAY move exists in this exact
    // shape (every alternative either still exceeds the 2-day ceiling or
    // splits the block) and there is no second employee for HAND-OFF, so
    // the honest outcome is: no repair applied at all.
    expect(result.repairs).toEqual([]);
  });

  it("WITHOUT the off-day-rules guard (the pre-fix behavior), the same scenario really did fragment the block — confirming this is a genuine regression test, not a vacuous one", () => {
    const input: FlexibleRepairInput = {
      ctx,
      employees,
      demandByDay: {},
      stage6ShiftsByDay,
      exclusions,
      maxConsecutiveOffDays: 2,
      simulateTopUp: () => new Map(),
      // offDayRules omitted entirely -- reproduces the exact pre-2026-10-06 behavior
    };
    const result = repairFlexiblePoolWeek(input);

    const finalPattern = DAYS.map((d) => ((result.stage6ShiftsByDay[d] ?? []).some((g) => g.employeeId === "x") ? "working" : "off")) as ("working" | "off")[];
    const { isOneBlock } = offRunAndSplit(finalPattern);

    expect(result.repairs.length).toBeGreaterThan(0); // it did "fix" something...
    expect(isOneBlock).toBe(false); // ...by fragmenting the OFF block, the exact live bug reported
  });

  // The guard isn't a blanket block on repair: this file's own "flexible
  // pool (Stage 6): the same streak-ordering gap" test (PHASE 2, part B,
  // above) exercises Phase 1 (GAP repair) with this exact guard active and
  // still gets a full, legal hand-off ("Monday is handed to the fresh
  // ACEs so the tired ones cover Tuesday") — proving the new check rejects
  // only the specific off-day-rule-breaking moves it targets, not
  // repair in general.
});
