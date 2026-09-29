import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { allocateProportionally, planAllowsDrawIn, planCapPacedRestDays } from "../lib/planning/cap-paced-rest";
import { generateForeignCompanyShifts, generateProfilingMesureShifts } from "../lib/planning/specialized-team-generation";
import { generateDraftWeeklyPlan, DraftWeeklyPlan } from "../lib/planning/generate-draft-plan";
import { aggregateDailyDemand, demandClustersForRole } from "../lib/planning/demand-aggregation";
import { resolveHardWorkCaps } from "../lib/planning/hard-work-caps";
import { isFlexibleGeneralPool } from "../lib/planning/workforce-pools";
import { deriveFallbackBoundaryContext } from "../lib/planning/rotation-context";
import { validateImportFile } from "../lib/flight-import";
import { restHoursBetween } from "../lib/roster-generation";
import { getShiftDurationHours, getShiftTimesAs } from "../lib/shift-templates";
import { flightDateFor } from "../lib/flight-date";
import { EMPLOYEES, CONFIG, FLIGHTS, DAYS_WITH_DATA, CURRENT_WEEK_START, CURRENT_WEEK_LABEL } from "../lib/seed-data";
import { Employee, Flight, StaffingRequirement } from "../lib/types";
import type { GeneratedShiftAssignment, PriorDayShiftMap } from "../lib/planning/shift-generation";

/**
 * CAP-PACED REST PLANNING (2026-09-25) — regression coverage for the
 * "whole specialized team hits the hard cap on the same day" lockstep.
 *
 * THE BUG: specialized-team-generation.ts's sortByLeastUsedFirst (the
 * 2026-09-21 fairness fix) keeps a team's hours so evenly spread that, once
 * the hard weekly-hours cap (42h) / consecutive-day cap (5) exist and the
 * week's demand exceeds what the team can legally work, every member reaches
 * the cap on (nearly) the same day. On the real 2026-10-05 stress week the
 * 24 Profiling+Mesure employees were 23/22/18/22/11 working Mon-Fri, then
 * 0/24 on Saturday AND Sunday. Tests below that run with
 * `capPacing: false` / `specializedCapPacing: false` reproduce the pre-fix
 * behaviour and assert the bug's shape, so they would fail if the fix were
 * silently removed; the paired run asserts the fixed behaviour.
 */

const WEEK = "2026-09-21"; // Monday, GMT regime
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const CAPS = resolveHardWorkCaps(CONFIG); // the real defaults: 42h / 5 days

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "emp", name: "Test", skills: ["Boarding"], assignment: "General T1 Pool",
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

/** A Profiling team of `size` and one RAM flight a day needing `need` distinct Profiling agents (one cluster/day). */
function profilingWeek(size: number, need: number, departure = "14:30") {
  const pool = Array.from({ length: size }, (_, i) => makeEmployee({ id: `p-${i}`, name: `P ${i}`, assignment: "Profiling", skills: ["Profiling"] }));
  const flights = DAYS.map((day) => makeFlight({ id: `ram-${day}`, day_of_week: day, flight_date: flightDateFor(WEEK, day), scheduled_departure: departure }));
  const reqs: StaffingRequirement[] = flights.map((f) => ({
    id: `r-${f.day_of_week}`, flight_id: f.id, role: "Profiling", baseline_requirement: need, additional_requirement: 0,
    total_requirement: need, source: "fixed_rule", reasoning: "", needs_configuration: false,
  }));
  const demandByDay = Object.fromEntries(DAYS.map((d) => [d, aggregateDailyDemand(d, flights, reqs)]));
  return { pool, demandByDay };
}

function runProfiling(size: number, need: number, capPacing: boolean, prior: PriorDayShiftMap = new Map(), incoming = new Map<string, number>()) {
  const { pool, demandByDay } = profilingWeek(size, need);
  return { pool, demandByDay, result: generateProfilingMesureShifts(DAYS, pool, demandByDay, 15, WEEK, prior, { caps: CAPS, incomingStreakByEmployee: incoming, capPacing }) };
}

/** A foreign team of `size` with one flight every day (Air France: confirmed headcount 3). */
function airFranceWeek(size: number) {
  const team = Array.from({ length: size }, (_, i) => makeEmployee({ id: `af-${i}`, name: `AF ${i}`, assignment: "Air France", foreign_company_authorizations: ["Air France"] }));
  const flights = DAYS.map((day) =>
    makeFlight({ id: `af-${day}`, flight_number: "AF1397", airline: "Air France", route: "CMN → ORY", destination: "ORY", aircraft: "Airbus A319", scheduled_departure: "12:10", day_of_week: day, flight_date: flightDateFor(WEEK, day), operator_type: "self_managed" })
  );
  return { team, flights };
}

function runAirFrance(size: number, capPacing: boolean) {
  const { team, flights } = airFranceWeek(size);
  return { team, result: generateForeignCompanyShifts(DAYS, team, flights, ["Air France"], 15, WEEK, new Map(), undefined, undefined, { caps: CAPS, incomingStreakByEmployee: new Map(), capPacing }) };
}

const countOn = (byDay: Record<string, GeneratedShiftAssignment[]>, day: string, ids: ReadonlySet<string>) => new Set((byDay[day] ?? []).filter((g) => ids.has(g.employeeId)).map((g) => g.employeeId)).size;
const hoursOf = (byDay: Record<string, GeneratedShiftAssignment[]>, id: string, weekStart: string, days = DAYS) =>
  days.reduce((sum, d) => sum + (byDay[d] ?? []).filter((g) => g.employeeId === id).reduce((s, g) => s + getShiftDurationHours(g.shiftCode, flightDateFor(weekStart, d)), 0), 0);
function maxRun(worked: boolean[], incoming = 0): number {
  let s = incoming;
  let m = incoming;
  for (const w of worked) {
    s = w ? s + 1 : 0;
    m = Math.max(m, s);
  }
  return m;
}

function loadWeek(file: string, weekStart: string): Flight[] {
  const csv = readFileSync(join(__dirname, "fixtures", file), "utf-8");
  return validateImportFile(csv, new Set(), weekStart).filter((r) => r.flight !== null).map((r) => r.flight!);
}
const STRESS_WEEK = "2026-10-05";
const HEAVY_WEEK = "2026-09-07";
const stressFlights = loadWeek("atlas_stress_week_2026-10-05.csv", STRESS_WEEK);
const heavyFlights = loadWeek("atlas_heavy_week_2026-09-07.csv", HEAVY_WEEK);
const stressPlan = (specializedCapPacing: boolean, hardCapRepair = true) =>
  generateDraftWeeklyPlan(stressFlights, EMPLOYEES, [], CONFIG, DAYS, "Week of Oct 5 2026", STRESS_WEEK, new Map(), "unknown", { specializedCapPacing, hardCapRepair });
const PROF_MESURE_IDS = new Set(EMPLOYEES.filter((e) => e.assignment === "Profiling" || e.assignment === "Mesure").map((e) => e.id));

// ---------------------------------------------------------------------------

describe("pure primitives", () => {
  it("allocateProportionally: proportional, largest remainder, never above a limit, ties spread evenly (not all to the earliest), rotation and prior load steer ties", () => {
    const a = allocateProportionally(48, [12, 12, 8, 12, 12, 12, 12]);
    expect(a.reduce((x, y) => x + y, 0)).toBe(48);
    expect(Math.max(...a.filter((_, i) => i !== 2)) - Math.min(...a.filter((_, i) => i !== 2))).toBeLessThanOrEqual(1);
    expect(a[2]).toBeLessThan(a[0]); // the lighter-demand day gets proportionally fewer
    // 3 spare units over 5 tied days: spread (0, 2, 4), not (0, 1, 2).
    expect(allocateProportionally(28, [7, 7, 7, 7, 7])).toEqual([6, 5, 6, 5, 6]);
    // Limits cap each index and the total (7 = 4 + 3 < 10).
    expect(allocateProportionally(10, [3, 3], [4, 3])).toEqual([4, 3]);
    // 1 spare unit over 3 tied clusters rotates with `rotation`.
    expect([0, 1, 2].map((r) => allocateProportionally(7, [4, 4, 4], [4, 4, 4], r).indexOf(3))).toEqual([1, 2, 0]);
    // Prior load: spare units go to the days a sibling covered least.
    expect(allocateProportionally(3, [1, 1, 1, 1], [1, 1, 1, 1], 0, [5, 5, 6, 5])).toEqual([1, 1, 0, 1]);
    expect(allocateProportionally(0, [1, 2])).toEqual([0, 0]);
  });

  it("planCapPacedRestDays is INACTIVE when capacity covers demand (the caller then keeps its exact prior behaviour)", () => {
    const plan = planCapPacedRestDays({ memberIds: ["a", "b", "c", "d", "e"], daysOrder: DAYS, demandByDay: [3, 3, 3, 0, 0, 0, 0], estimatedShiftHoursByDay: DAYS.map(() => 9), caps: CAPS, incomingStreakByEmployee: new Map() });
    expect(plan.active).toBe(false);
    expect(plan.preferredWorkDays.size).toBe(0);
    expect(plan).toMatchObject({ capacityDays: 15, demandDays: 9 });
  });

  it("planCapPacedRestDays, capacity-constrained (2026-09-29 REPLACEMENT — capacity is now streak-only): plans exactly the capacity, spread over the week in proportion to demand, staggered across members, within the consecutive-work-day cap", () => {
    // BEFORE the 2026-09-29 hours-cap removal, a 4-member team fully needed
    // every day (demand 3/day) was capacity-constrained at 16 legal
    // person-days under the old 42h ceiling. With capacity now purely
    // streak-based, each member's capacity over a full 7-day demand week is 6
    // (5 in a row, forced rest, then 1 more) — a 4-member team's 24 person-
    // days comfortably covers 21 needed, so that fixture is no longer
    // constrained at all (see the "no day planned empty" comment above this
    // block for the general shape). A 3-member team, still fully needed
    // every day, keeps the fixture genuinely constrained: 3 x 6 = 18 < 21.
    const ids = ["a", "b", "c"];
    const plan = planCapPacedRestDays({ memberIds: ids, daysOrder: DAYS, demandByDay: DAYS.map(() => 3), estimatedShiftHoursByDay: DAYS.map(() => 9), caps: CAPS, incomingStreakByEmployee: new Map() });
    expect(plan).toMatchObject({ active: true, capacityDays: 18, demandDays: 21 });
    expect(plan.plannedWorkersByDay.reduce((x, y) => x + y, 0)).toBe(18);
    expect(Math.min(...plan.plannedWorkersByDay)).toBeGreaterThanOrEqual(2); // no day planned empty
    for (const id of ids) {
      const worked = DAYS.map((d) => plan.preferredWorkDays.get(id)!.has(d));
      expect(worked.filter(Boolean).length, id).toBe(6); // 6 of 7: one forced rest day under the 5-consecutive-day cap
      expect(maxRun(worked), id).toBeLessThanOrEqual(5);
    }
    // Staggered: the members' rest days are not all the same days.
    const restSets = ids.map((id) => DAYS.filter((d) => !plan.preferredWorkDays.get(id)!.has(d)).join(","));
    expect(new Set(restSets).size).toBeGreaterThan(1);
  });

  it("planCapPacedRestDays honours a real incoming streak (never plans a 6th consecutive day)", () => {
    const plan = planCapPacedRestDays({ memberIds: ["tired", "fresh"], daysOrder: DAYS, demandByDay: DAYS.map(() => 2), estimatedShiftHoursByDay: DAYS.map(() => 6), caps: CAPS, incomingStreakByEmployee: new Map([["tired", 5]]) });
    expect(plan.active).toBe(true);
    expect(plan.preferredWorkDays.get("tired")!.has("Monday")).toBe(false);
    for (const id of ["tired", "fresh"]) expect(maxRun(DAYS.map((d) => plan.preferredWorkDays.get(id)!.has(d)), id === "tired" ? 5 : 0), id).toBeLessThanOrEqual(5);
  });

  it("planAllowsDrawIn (2026-09-29 REPLACEMENT — the gate is now purely the 5-consecutive-work-day cap, never hours): drawing in a member resting to protect a later run is refused; drawing in a member whose rest already broke their streak, or who has no run left to protect, is allowed", () => {
    // 3 members, demand 3/day on 6 days then 1 on Sunday: still genuinely
    // capacity-constrained (18 legal person-days < 19 needed), but with a
    // dip that leaves some rests NOT right at the cap edge.
    const ids = ["a", "b", "c"];
    const demand = [3, 3, 3, 3, 3, 3, 1];
    const plan = planCapPacedRestDays({ memberIds: ids, daysOrder: DAYS, demandByDay: demand, estimatedShiftHoursByDay: DAYS.map(() => 9), caps: CAPS, incomingStreakByEmployee: new Map() });
    expect(plan).toMatchObject({ active: true, capacityDays: 18, demandDays: 19 });
    // b rests both Saturday and Sunday: drawing in on Saturday would extend a
    // real 5-day run (Mon-Fri) into a 6th — refused.
    expect(plan.preferredWorkDays.get("b")!.has("Saturday")).toBe(false);
    expect(planAllowsDrawIn(plan, "b", 5, 0, 5)).toBe(false);
    // ...but Sunday, entered with a streak already reset to 0 by Saturday's
    // rest, has nothing left to protect — drawing in is allowed.
    expect(plan.preferredWorkDays.get("b")!.has("Sunday")).toBe(false);
    expect(planAllowsDrawIn(plan, "b", 6, 0, 0)).toBe(true);
    // c rests Sunday too, entering with a real streak of 3 (Thu/Fri/Sat) and
    // no more preferred days after it to protect — also allowed.
    expect(plan.preferredWorkDays.get("c")!.has("Sunday")).toBe(false);
    expect(planAllowsDrawIn(plan, "c", 6, 0, 3)).toBe(true);
    // An unknown member (not in any active plan) is never held back.
    expect(planAllowsDrawIn(plan, "stranger", 0, 0, 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("TEST 1 — the lockstep bug at small scale: late-week coverage no longer collapses to zero", () => {
  it("Profiling (2026-09-29 REPLACEMENT — capacity is now streak-only, so a 4-member team fully covers 3/day and is no longer constrained: a 3-member team, still fully needed every day, is): 18 legal person-days < 21: BEFORE the fix the whole team caps out and Saturday is 0/3; AFTER, every day keeps real coverage", () => {
    // BEFORE the 2026-09-29 hours-cap removal, a 4-member team needing 3/day
    // was constrained at 16 legal person-days under the old 42h ceiling. With
    // capacity now purely streak-based (6 of 7 days per member on a fully-
    // demanded week), that 4-member fixture reaches 24 >= 21 and is no longer
    // constrained at all. A 3-member team, still fully needed every day,
    // keeps the same shape genuinely constrained (3 x 6 = 18 < 21) — the
    // "whole team caps out together" day lands on Saturday here rather than
    // Sunday, since 3 fully-utilized members' streaks resolve differently
    // than 4's, but the bug's shape (a zero day) is otherwise identical.
    const ids = new Set(["p-0", "p-1", "p-2"]);
    // BEFORE (pre-fix behaviour): full coverage early, the whole team capped together, a zero day at the end.
    const before = runProfiling(3, 3, false).result;
    const beforeCounts = DAYS.map((d) => countOn(before.generatedShiftsByDay, d, ids));
    expect(beforeCounts.slice(0, 5)).toEqual([3, 3, 3, 3, 3]);
    expect(beforeCounts[5]).toBe(0); // Saturday: nobody left under the cap
    // AFTER: same total legal capacity, spread across the week, no zero day.
    const after = runProfiling(3, 3, true).result;
    const afterCounts = DAYS.map((d) => countOn(after.generatedShiftsByDay, d, ids));
    expect(afterCounts.reduce((x, y) => x + y, 0)).toBe(beforeCounts.reduce((x, y) => x + y, 0));
    expect(Math.min(...afterCounts)).toBeGreaterThanOrEqual(2);
    expect(afterCounts[5]).toBeGreaterThan(0);
    // Every shortfall is an honest paced conflict (needed 3, covered 2), naming who rested.
    expect(after.conflicts.length).toBeGreaterThan(0);
    for (const c of after.conflicts) {
      expect(c).toMatchObject({ team: "Profiling", needed: 3, covered: 2 });
      expect(c.capPacing).toMatchObject({ teamCapacityDays: 18, weekDemandDays: 21 });
      expect(c.capPacing!.heldBack.length).toBeGreaterThan(0);
    }
  });

  it("the REAL 2026-10-05 stress week (2026-09-29 REPLACEMENT — capacity is now streak-only): the original 0/24 Saturday-and-Sunday collapse this test pinned no longer reproduces at all, even with pacing off, since removing the hours ceiling roughly doubled real per-member capacity; pacing still evens the week out and every day stays well covered", () => {
    // BEFORE the 2026-09-29 hours-cap removal, this pinned the ORIGINAL bug's
    // shape on real data: Profiling+Mesure fell to 0/24 on BOTH Saturday and
    // Sunday under the old 42h ceiling. With capacity now purely streak-based
    // (roughly 6 of 7 days/member instead of ~4), the team's real weekly
    // capacity is high enough that even the UNPACED greedy never produces a
    // zero day here — the lockstep bug's precondition (legal capacity below
    // real demand) no longer holds for this fixture. Pacing (still a real,
    // tested mechanism — see TEST 1's synthetic fixture above, which remains
    // genuinely constrained) still smooths the week's distribution.
    const count = (p: DraftWeeklyPlan, day: string) => countOn(p.generatedShiftsByDay, day, PROF_MESURE_IDS);
    const before = stressPlan(false);
    expect(PROF_MESURE_IDS.size).toBe(24);
    expect(Math.min(...DAYS.map((d) => count(before, d)))).toBeGreaterThan(0); // no collapse even unpaced
    const after = stressPlan(true);
    const perDay = DAYS.map((d) => count(after, d));
    expect(Math.min(...perDay)).toBeGreaterThanOrEqual(15);
    // Nobody in the team breaks the real hard cap (consecutive work days); weekly hours are no longer a ceiling.
    for (const id of PROF_MESURE_IDS) {
      expect(maxRun(DAYS.map((d) => after.generatedShiftsByDay[d].some((g) => g.employeeId === id))), id).toBeLessThanOrEqual(5);
    }
  });
});

// ---------------------------------------------------------------------------

describe("TEST 3 — the staggering only affects ORDER / who rests, never eligibility: every hard constraint still filters", () => {
  it("rest: the plan prefers p-0 on Monday, but p-0's real prior shift leaves < 15h before any covering code — p-0 is still excluded, and nobody's rest drops below 15h", () => {
    // Team of 3, ALL 3 needed daily (2026-09-29 REPLACEMENT: capacity is now
    // streak-only, so a lighter "2 of 3 needed" shape is no longer
    // constrained at all — see TEST 1's doc comment; a fully-saturated team
    // still is: 18 legal person-days < 21 -> the plan is active) at an early departure.
    const { pool, demandByDay } = profilingWeek(3, 3, "07:30");
    const cluster = demandClustersForRole(demandByDay["Monday"], "Profiling")[0];
    const prior: PriorDayShiftMap = new Map([["p-0", { shift_start: "14:00", shift_end: "23:30" }]]);
    const plan = planCapPacedRestDays({ memberIds: pool.map((e) => e.id), daysOrder: DAYS, demandByDay: DAYS.map(() => 3), estimatedShiftHoursByDay: DAYS.map(() => 9), caps: CAPS, incomingStreakByEmployee: new Map() });
    expect(plan.active).toBe(true);
    expect(plan.preferredWorkDays.get("p-0")!.has("Monday")).toBe(true); // the plan wants p-0 on Monday...
    const { generatedShiftsByDay } = generateProfilingMesureShifts(DAYS, pool, demandByDay, 15, WEEK, prior, { caps: CAPS, incomingStreakByEmployee: new Map() });
    // ...but p-0 is not rest-legal for Monday's early window, so the unchanged filter excludes them.
    expect(cluster.start < "09:00").toBe(true);
    expect(generatedShiftsByDay["Monday"].some((g) => g.employeeId === "p-0")).toBe(false);
    for (const e of pool) {
      let last = prior.get(e.id) ?? null;
      for (const d of DAYS) {
        const g = generatedShiftsByDay[d].find((x) => x.employeeId === e.id);
        const times = g ? getShiftTimesAs(g.shiftCode, flightDateFor(WEEK, d)) : null;
        if (last && times) expect(restHoursBetween(last.shift_start, last.shift_end, times.shift_start), `${e.id} ${d}`).toBeGreaterThanOrEqual(15);
        last = times;
      }
    }
  });

  it("hard caps: a member the plan would place is still excluded when a real cap forbids it (incoming 5-day streak), and nobody ever exceeds 5 consecutive days (weekly hours are no longer a ceiling, 2026-09-29 removal)", () => {
    const incoming = new Map([["p-0", 5]]);
    const { pool, result } = runProfiling(4, 3, true, new Map(), incoming);
    expect(result.generatedShiftsByDay["Monday"].some((g) => g.employeeId === "p-0")).toBe(false);
    for (const e of pool) expect(maxRun(DAYS.map((d) => result.generatedShiftsByDay[d].some((g) => g.employeeId === e.id)), incoming.get(e.id) ?? 0), e.id).toBeLessThanOrEqual(5);
  });

  it("qualification / role split (Gulf Air, 7 ACE + 1 Leader) (2026-09-29 REPLACEMENT): with the hours ceiling removed there is no longer any day the plan needs to rest the Leader — the single Leader slot is filled every flight day, and it is never filled by an ACE", () => {
    // BEFORE the 2026-09-29 removal, "3 x >= 11.25h fits under 42h, a 4th
    // does not" forced the Leader to rest one of the 4 (non-consecutive)
    // flight days. With no hours ceiling and these 4 days never consecutive,
    // the Leader now covers every one of them; the role split itself
    // (never substituted by an ACE) is unchanged and still real.
    const team = [
      ...[1, 2, 3, 4, 5, 6, 7].map((i) => makeEmployee({ id: `gf-ace-${i}`, name: `GF Ace ${i}`, assignment: "Gulf Air", team_role: "ace", foreign_company_authorizations: ["Gulf Air"] })),
      makeEmployee({ id: "gf-leader", name: "GF Leader", assignment: "Gulf Air", team_role: "leader", foreign_company_authorizations: ["Gulf Air"] }),
    ];
    const flightDays = ["Monday", "Wednesday", "Friday", "Sunday"];
    const flights = flightDays.map((day) => makeFlight({ id: `gf-${day}`, flight_number: "GF105", airline: "Gulf Air", route: "CMN → BAH", destination: "BAH", aircraft: "Airbus A320", scheduled_departure: "09:00", day_of_week: day, flight_date: flightDateFor(WEEK, day), operator_type: "self_managed" }));
    const { generatedShiftsByDay } = generateForeignCompanyShifts(DAYS, team, flights, ["Gulf Air"], 15, WEEK, new Map(), undefined, undefined, { caps: CAPS, incomingStreakByEmployee: new Map() });
    const leaderDays = flightDays.filter((d) => generatedShiftsByDay[d].some((g) => g.employeeId === "gf-leader"));
    expect(leaderDays.length).toBe(4); // no capacity throttle forces a rotation any more
    for (const d of flightDays) {
      const aces = generatedShiftsByDay[d].filter((g) => g.employeeId.startsWith("gf-ace-")).length;
      expect(aces, d).toBeLessThanOrEqual(7);
      expect(generatedShiftsByDay[d].filter((g) => g.employeeId === "gf-leader").length, d).toBe(1); // never substituted by an ACE, never left empty
    }
  });

  it("the whole real stress week: every Profiling/Mesure/foreign-company member stays <= 5 consecutive days and >= 15h rest (weekly hours are no longer a ceiling, 2026-09-29 removal)", () => {
    const p = stressPlan(true);
    const ids = EMPLOYEES.filter((e) => e.active && (PROF_MESURE_IDS.has(e.id) || e.foreign_company_authorizations.includes(e.assignment))).map((e) => e.id);
    expect(ids.length).toBeGreaterThan(24);
    for (const id of ids) expect(maxRun(DAYS.map((d) => p.generatedShiftsByDay[d].some((g) => g.employeeId === id))), id).toBeLessThanOrEqual(5);
    expect(p.issues.filter((i) => i.type === "rest_violation")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("TEST 4 — determinism", () => {
  it("same input -> identical output (planner, Profiling/Mesure, foreign company, full pipeline)", () => {
    const input = { memberIds: ["a", "b", "c", "d"], daysOrder: DAYS, demandByDay: DAYS.map(() => 3), estimatedShiftHoursByDay: DAYS.map(() => 9), caps: CAPS, incomingStreakByEmployee: new Map<string, number>(), maxConsecutiveOffDays: 2 };
    expect(planCapPacedRestDays(input)).toEqual(planCapPacedRestDays(input));
    expect(runProfiling(4, 3, true).result).toEqual(runProfiling(4, 3, true).result);
    expect(runAirFrance(4, true).result).toEqual(runAirFrance(4, true).result);
    const strip = (p: DraftWeeklyPlan) => {
      const { generatedAt, ...rest } = p;
      void generatedAt;
      return rest;
    };
    expect(strip(stressPlan(true))).toEqual(strip(stressPlan(true)));
  });
});

// ---------------------------------------------------------------------------

describe("TEST 5 — Stage 6's flexible pool is untouched", () => {
  const flexIds = new Set(EMPLOYEES.filter(isFlexibleGeneralPool).map((e) => e.id));
  const flexOnly = (p: DraftWeeklyPlan) => DAYS.map((d) => (p.generatedShiftsByDay[d] ?? []).filter((g) => flexIds.has(g.employeeId)));
  const flexExclusions = (p: DraftWeeklyPlan) => p.hardCapExclusions.filter((x) => x.population === "flexible_pool" || x.population === "flexible_pool_top_up");

  it("real stress week, Stage 6 + its top-up (the phase-2 repair isolated off): flexible-pool shifts and cap exclusions are byte-identical with the fix on or off", () => {
    const off = stressPlan(false, false);
    const on = stressPlan(true, false);
    expect(flexIds.size).toBeGreaterThan(0);
    expect(JSON.stringify(flexOnly(on))).toBe(JSON.stringify(flexOnly(off)));
    expect(flexExclusions(on)).toEqual(flexExclusions(off));
  });

  it("the demo week with everything on (repair included): the flexible pool is byte-identical", () => {
    const boundary = deriveFallbackBoundaryContext(EMPLOYEES, DAYS_WITH_DATA, CURRENT_WEEK_START);
    const gen = (specializedCapPacing: boolean) => generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_LABEL, CURRENT_WEEK_START, boundary, "fallback_static_baseline", { specializedCapPacing });
    const off = gen(false);
    const on = gen(true);
    const flex = (p: DraftWeeklyPlan) => JSON.stringify(DAYS_WITH_DATA.map((d) => (p.generatedShiftsByDay[d] ?? []).filter((g) => flexIds.has(g.employeeId))));
    expect(flex(on)).toBe(flex(off));
  });
});

// ---------------------------------------------------------------------------

describe("TEST 6 — foreign-company teams had the same defect and get the same fix", () => {
  it("Air France with a 4-person team (2026-09-29 REPLACEMENT): with the hours ceiling removed, capacity (4 x 6 = 24) now comfortably covers the 21 needed person-days, so this fixture is no longer constrained at all — every flight day is fully covered (3/3) with the fix on OR off", () => {
    // BEFORE the 2026-09-29 removal, "16 legal person-days < 21" forced a
    // lockstep collapse (Sunday 0/3) with pacing off. With capacity now
    // purely streak-based, a 4-person team fully covers 3/day every day even
    // WITHOUT pacing — there is no shortfall left for pacing to smooth.
    const ids = new Set(["af-0", "af-1", "af-2", "af-3"]);
    const covered = (r: ReturnType<typeof runAirFrance>["result"], d: string) => new Set(r.generatedShiftsByDay[d].filter((g) => g.coversRoles.includes("Air France") && ids.has(g.employeeId)).map((g) => g.employeeId)).size;
    const before = runAirFrance(4, false).result;
    expect(DAYS.map((d) => covered(before, d))).toEqual(DAYS.map(() => 3));
    expect(before.conflicts).toEqual([]);
    const after = runAirFrance(4, true).result;
    expect(DAYS.map((d) => covered(after, d))).toEqual(DAYS.map(() => 3));
    expect(after.conflicts).toEqual([]);
  });

  it("the REAL 2026-09-07 heavy week (2026-09-29 REPLACEMENT): Gulf Air's old 8/8/8/8/0 lockstep collapse (and the paced 7/6/6/6/7 fix for it) no longer occurs — 8 members now cover all 5 flight days in full, 8/8/8/8/8, with the fix on or off", () => {
    // BEFORE the 2026-09-29 hours-cap removal, this real week's Gulf Air
    // team hit the old 42h ceiling in lockstep (0 on Sunday unpaced, an even
    // 7/6/6/6/7 paced). With capacity now purely streak-based (5 non-
    // consecutive flight days never risk the 5-consecutive-day cap at all),
    // the team fully covers every flight day regardless of pacing.
    const gulfIds = new Set(EMPLOYEES.filter((e) => e.active && e.assignment === "Gulf Air").map((e) => e.id));
    const gen = (specializedCapPacing: boolean) => generateDraftWeeklyPlan(heavyFlights, EMPLOYEES, [], CONFIG, DAYS, "W", HEAVY_WEEK, new Map(), "unknown", { specializedCapPacing });
    const flightDaysOf = (p: DraftWeeklyPlan) => DAYS.map((d) => p.generatedShiftsByDay[d].filter((g) => gulfIds.has(g.employeeId) && g.coversRoles.includes("Gulf Air")).length);
    const before = flightDaysOf(gen(false));
    expect(before).toEqual([8, 0, 8, 0, 8, 8, 8]);
    const on = gen(true);
    const after = flightDaysOf(on);
    expect(after).toEqual(before);
    expect(on.configurationIssues.find((c) => c.requirementId === "specialized-demand-conflict-Gulf Air-Sunday")).toBeUndefined();
  });

  it("no-op when capacity suffices: a foreign team with enough legal capacity is byte-identical with the fix on or off", () => {
    // 5 members, 3 needed on 3 flight days only: 9 person-days << capacity.
    const { team, flights } = airFranceWeek(5);
    const some = flights.filter((f) => ["Monday", "Wednesday", "Friday"].includes(f.day_of_week));
    const gen = (capPacing: boolean) => generateForeignCompanyShifts(DAYS, team, some, ["Air France"], 15, WEEK, new Map(), CONFIG, undefined, { caps: CAPS, incomingStreakByEmployee: new Map(), capPacing });
    expect(gen(true)).toEqual(gen(false));
  });

  it("no-op when capacity suffices: the whole demo plan is byte-identical with the fix on or off", () => {
    const boundary = deriveFallbackBoundaryContext(EMPLOYEES, DAYS_WITH_DATA, CURRENT_WEEK_START);
    const gen = (specializedCapPacing: boolean) => {
      const { generatedAt, ...rest } = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_LABEL, CURRENT_WEEK_START, boundary, "fallback_static_baseline", { specializedCapPacing });
      void generatedAt;
      return rest;
    };
    expect(gen(true)).toEqual(gen(false));
  });
});

// ---------------------------------------------------------------------------

/**
 * TEST 7 — COVERAGE-GROUP ALLOCATION (2026-09-29 follow-up fix).
 *
 * THE BUG this covers: once a Profiling/Mesure team is genuinely
 * capacity-constrained (cap-paced rest active), assignPacedProfilingMesureDay
 * split each day's PREFERRED workers across demand CLUSTERS in proportion to
 * each cluster's own raw peak — even when two clusters are both fully inside
 * the SAME catalog shift code's span (e.g. two morning flights both covered
 * by one 05:45-14:45 shift). That double-counted the morning side's real
 * need (duty-generation, Stage 9, reuses one working person across every
 * non-overlapping requirement window their real shift spans — see
 * duty-generation.ts), handing it MORE preferred workers than it could ever
 * use while an evening bank needing its OWN, non-overlapping shift code
 * (e.g. 13:45-22:45) was starved of the workers it genuinely needed.
 *
 * Real 2026-10-05 stress week, Monday, Mesure: two morning requirements
 * (both MT03-covered) plus one evening requirement (AP01-covered) — see
 * docs/known-limitations/roster-planning-vs-duty-allocation.md's
 * "2026-09-29" section for the full trace.
 */
describe("TEST 7 — coverage-group allocation: a day's preferred workers are no longer double-counted across clusters the same shift code covers", () => {
  /** A Profiling team with, every day, two morning flights (both MT03-covered, non-overlapping) and one evening flight (AP01-covered, disjoint from MT03) — the real Monday Mesure shape from the 2026-10-05 stress week, at a size and need small enough to compute by hand. */
  function twoBankWeek(size: number, needEach: number) {
    const pool = Array.from({ length: size }, (_, i) => makeEmployee({ id: `q-${i}`, name: `Q ${i}`, assignment: "Profiling", skills: ["Profiling"] }));
    const flights = DAYS.flatMap((day) => [
      makeFlight({ id: `m1-${day}`, day_of_week: day, flight_date: flightDateFor(WEEK, day), scheduled_departure: "09:15" }), // window 08:15-09:15, MT03-covered
      makeFlight({ id: `m2-${day}`, day_of_week: day, flight_date: flightDateFor(WEEK, day), scheduled_departure: "12:00" }), // window 11:00-12:00, MT03-covered, separate cluster (zero demand 09:15-11:00)
      makeFlight({ id: `e1-${day}`, day_of_week: day, flight_date: flightDateFor(WEEK, day), scheduled_departure: "20:00" }), // window 19:00-20:00, AP01-covered, disjoint from MT03
    ]);
    const reqs: StaffingRequirement[] = flights.map((f) => ({
      id: `r-${f.id}`, flight_id: f.id, role: "Profiling", baseline_requirement: needEach, additional_requirement: 0,
      total_requirement: needEach, source: "fixed_rule", reasoning: "", needs_configuration: false,
    }));
    const demandByDay = Object.fromEntries(DAYS.map((d) => [d, aggregateDailyDemand(d, flights, reqs)]));
    return { pool, flights, demandByDay };
  }

  function runTwoBank(size: number, needEach: number, capPacing: boolean) {
    const { pool, demandByDay } = twoBankWeek(size, needEach);
    return generateProfilingMesureShifts(DAYS, pool, demandByDay, 15, WEEK, new Map(), { caps: CAPS, incomingStreakByEmployee: new Map(), capPacing });
  }

  it("4 members, 2 needed per bank (2026-09-29 REPLACEMENT — a smaller team keeps pacing genuinely active): a held-back member costs BOTH of the morning bank's non-overlapping clusters together, never double-counted into two separate shortfalls", () => {
    // BEFORE the 2026-09-29 hours-cap removal, a 7-member team at this same
    // shape was exactly hours-capacity-tight (42h cap -> 4 workdays/member ->
    // 28 legal person-days) and pacing was genuinely engaged. With capacity
    // now streak-only (7 x 6 = 42 >> 28 needed), a 7-member team is no longer
    // capacity-constrained at all, so pacing sits inactive and this block's
    // actual subject — assignPacedProfilingMesureDay's coverage-group SHARE
    // ALLOCATION — never runs. A 4-member team keeps the same shape genuinely
    // constrained (4 x 6 = 24 < 28 needed), so pacing stays active here.
    const after = runTwoBank(4, 2, true);
    const codesOn = (r: ReturnType<typeof runTwoBank>, day: string, code: string) => r.generatedShiftsByDay[day].filter((g) => g.shiftCode === code).length;
    expect(DAYS.map((d) => codesOn(after, d, "AP01"))).toEqual([2, 2, 2, 2, 1, 2, 1]);
    expect(DAYS.map((d) => codesOn(after, d, "MT03"))).toEqual([1, 2, 1, 2, 2, 1, 2]);
    expect(after.conflicts).toHaveLength(8);
    for (const c of after.conflicts) expect(c).toMatchObject({ team: "Profiling", needed: 2, covered: 1 }); // never the old double-counted peak
    // On a day where BOTH morning clusters are short, they are short because
    // of the SAME held-back member (one person's single MT03 shift spans
    // both non-overlapping windows) — not two independently-counted people.
    const morningConflictsByDay = new Map<string, typeof after.conflicts>();
    for (const c of after.conflicts) {
      if (c.window.start === "08:00" || c.window.start === "11:00") {
        morningConflictsByDay.set(c.dayOfWeek, [...(morningConflictsByDay.get(c.dayOfWeek) ?? []), c]);
      }
    }
    for (const [day, cs] of morningConflictsByDay) {
      expect(cs, day).toHaveLength(2);
      expect(cs[0].capPacing?.heldBack, day).toEqual(cs[1].capPacing?.heldBack);
    }
    expect(morningConflictsByDay.size).toBeGreaterThan(0); // the shared-group scenario actually occurred
  });

  it("no double-booking side effect: nobody is assigned twice into generatedShiftsByDay for a day their one shift covers two clusters, and their hours are counted exactly once", () => {
    const after = runTwoBank(7, 2, true);
    for (const day of DAYS) {
      const ids = after.generatedShiftsByDay[day].map((g) => g.employeeId);
      expect(new Set(ids).size, day).toBe(ids.length); // no employee appears twice for the same day
    }
  });

  it("no regression: a team whose demand is UNDER capacity keeps its exact pre-existing (non-paced) two-cluster-per-code behaviour, byte-identical", () => {
    // 12 members, 2 needed per bank: capacity comfortably covers demand, so pacing stays inactive and this is the untouched greedy path — must be byte-for-byte unaffected by this fix.
    const before = runTwoBank(12, 2, false);
    const after = runTwoBank(12, 2, true);
    expect(after).toEqual(before);
  });

  it("no regression: the real 2026-10-05 stress week never drops a whole specialized team to zero on any day (the ORIGINAL lockstep bug this fix must not reintroduce)", () => {
    const plan = stressPlan(true);
    const profIds = new Set(EMPLOYEES.filter((e) => e.assignment === "Profiling").map((e) => e.id));
    const mesureIds = new Set(EMPLOYEES.filter((e) => e.assignment === "Mesure").map((e) => e.id));
    for (const day of DAYS) {
      expect(countOn(plan.generatedShiftsByDay, day, profIds), `Profiling ${day}`).toBeGreaterThan(0);
      expect(countOn(plan.generatedShiftsByDay, day, mesureIds), `Mesure ${day}`).toBeGreaterThan(0);
    }
  });
});
