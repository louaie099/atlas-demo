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

  it("planCapPacedRestDays, capacity-constrained: plans exactly the capacity, spread over the week in proportion to demand, staggered across members, within both caps", () => {
    const ids = ["a", "b", "c", "d"];
    const plan = planCapPacedRestDays({ memberIds: ids, daysOrder: DAYS, demandByDay: DAYS.map(() => 3), estimatedShiftHoursByDay: DAYS.map(() => 9), caps: CAPS, incomingStreakByEmployee: new Map() });
    expect(plan).toMatchObject({ active: true, capacityDays: 16, demandDays: 21 });
    expect(plan.plannedWorkersByDay.reduce((x, y) => x + y, 0)).toBe(16);
    expect(Math.min(...plan.plannedWorkersByDay)).toBeGreaterThanOrEqual(2); // no day planned empty
    for (const id of ids) {
      const worked = DAYS.map((d) => plan.preferredWorkDays.get(id)!.has(d));
      expect(worked.filter(Boolean).length, id).toBe(4); // 4 x 9h = 36h <= 42h
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

  it("planAllowsDrawIn: only when working today cannot cost one of the member's own later planned days", () => {
    const plan = planCapPacedRestDays({ memberIds: ["a", "b", "c", "d"], daysOrder: DAYS, demandByDay: DAYS.map(() => 3), estimatedShiftHoursByDay: DAYS.map(() => 9), caps: CAPS, incomingStreakByEmployee: new Map() });
    const resting = ["a", "b", "c", "d"].find((id) => !plan.preferredWorkDays.get(id)!.has("Monday"))!;
    // 4 planned days x 9h = 36h still ahead: +9h today = 45h > 42h.
    expect(planAllowsDrawIn(plan, resting, 0, 0, 0)).toBe(false);
    // An unknown member (not in any active plan) is never held back.
    expect(planAllowsDrawIn(plan, "stranger", 0, 0, 0)).toBe(true);
    // With a lighter estimate there is room for an extra day.
    const light = planCapPacedRestDays({ memberIds: ["a", "b", "c", "d"], daysOrder: DAYS, demandByDay: DAYS.map(() => 3), estimatedShiftHoursByDay: DAYS.map((_, i) => (i === 0 ? 5 : 9)), caps: CAPS, incomingStreakByEmployee: new Map() });
    const lightResting = ["a", "b", "c", "d"].find((id) => !light.preferredWorkDays.get(id)!.has("Monday"))!;
    const ahead = DAYS.filter((d) => light.preferredWorkDays.get(lightResting)!.has(d)).length * 9;
    expect(planAllowsDrawIn(light, lightResting, 0, 0, 0)).toBe(ahead + 5 <= 42);
  });
});

// ---------------------------------------------------------------------------

describe("TEST 1 — the lockstep bug at small scale: late-week coverage no longer collapses to zero", () => {
  it("Profiling (4 members, 3 needed daily, 9h codes: 16 legal person-days < 21): BEFORE the fix the whole team caps out and Sunday is 0/3; AFTER, every day keeps real coverage", () => {
    const ids = new Set(["p-0", "p-1", "p-2", "p-3"]);
    // BEFORE (pre-fix behaviour): full coverage early, the whole team capped together, a zero day at the end.
    const before = runProfiling(4, 3, false).result;
    const beforeCounts = DAYS.map((d) => countOn(before.generatedShiftsByDay, d, ids));
    expect(beforeCounts.slice(0, 4)).toEqual([3, 3, 3, 3]);
    expect(beforeCounts[6]).toBe(0); // Sunday: nobody left under the cap
    // AFTER: same total legal capacity, spread across the week, no zero day.
    const after = runProfiling(4, 3, true).result;
    const afterCounts = DAYS.map((d) => countOn(after.generatedShiftsByDay, d, ids));
    expect(afterCounts.reduce((x, y) => x + y, 0)).toBe(beforeCounts.reduce((x, y) => x + y, 0));
    expect(Math.min(...afterCounts)).toBeGreaterThanOrEqual(2);
    expect(afterCounts[5]).toBeGreaterThan(0);
    expect(afterCounts[6]).toBeGreaterThan(0);
    // Every shortfall is an honest paced conflict (needed 3, covered 2), naming who rested.
    expect(after.conflicts.length).toBeGreaterThan(0);
    for (const c of after.conflicts) {
      expect(c).toMatchObject({ team: "Profiling", needed: 3, covered: 2 });
      expect(c.capPacing).toMatchObject({ teamCapacityDays: 16, weekDemandDays: 21 });
      expect(c.capPacing!.heldBack.length).toBeGreaterThan(0);
    }
  });

  it("the REAL 2026-10-05 stress week (154 flights, real seed workforce): Profiling+Mesure Saturday/Sunday go from 0/24 to real coverage", () => {
    const count = (p: DraftWeeklyPlan, day: string) => countOn(p.generatedShiftsByDay, day, PROF_MESURE_IDS);
    const before = stressPlan(false);
    expect(PROF_MESURE_IDS.size).toBe(24);
    expect(count(before, "Saturday")).toBe(0);
    expect(count(before, "Sunday")).toBe(0);
    const after = stressPlan(true);
    const perDay = DAYS.map((d) => count(after, d));
    expect(count(after, "Saturday")).toBeGreaterThanOrEqual(12);
    expect(count(after, "Sunday")).toBeGreaterThanOrEqual(12);
    expect(Math.min(...perDay)).toBeGreaterThanOrEqual(10);
    // The same legal capacity — just no longer spent entirely by Thursday.
    expect(perDay.reduce((x, y) => x + y, 0)).toBe(DAYS.reduce((n, d) => n + count(before, d), 0));
    // Nobody in the team breaks either hard cap.
    for (const id of PROF_MESURE_IDS) {
      expect(hoursOf(after.generatedShiftsByDay, id, STRESS_WEEK), id).toBeLessThanOrEqual(42);
      expect(maxRun(DAYS.map((d) => after.generatedShiftsByDay[d].some((g) => g.employeeId === id))), id).toBeLessThanOrEqual(5);
    }
  });
});

// ---------------------------------------------------------------------------

describe("TEST 3 — the staggering only affects ORDER / who rests, never eligibility: every hard constraint still filters", () => {
  it("rest: the plan prefers p-0 on Monday, but p-0's real prior shift leaves < 15h before any covering code — p-0 is still excluded, and nobody's rest drops below 15h", () => {
    // Team of 3, 2 needed daily at an early departure: 12 legal person-days < 14 -> the plan is active.
    const { pool, demandByDay } = profilingWeek(3, 2, "07:30");
    const cluster = demandClustersForRole(demandByDay["Monday"], "Profiling")[0];
    const prior: PriorDayShiftMap = new Map([["p-0", { shift_start: "14:00", shift_end: "23:30" }]]);
    const plan = planCapPacedRestDays({ memberIds: pool.map((e) => e.id), daysOrder: DAYS, demandByDay: DAYS.map(() => 2), estimatedShiftHoursByDay: DAYS.map(() => 9), caps: CAPS, incomingStreakByEmployee: new Map() });
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

  it("hard caps: a member the plan would place is still excluded when a real cap forbids it (incoming 5-day streak), and nobody ever exceeds 42h or 5 consecutive days", () => {
    const incoming = new Map([["p-0", 5]]);
    const { pool, result } = runProfiling(4, 3, true, new Map(), incoming);
    expect(result.generatedShiftsByDay["Monday"].some((g) => g.employeeId === "p-0")).toBe(false);
    for (const e of pool) {
      expect(hoursOf(result.generatedShiftsByDay, e.id, WEEK), e.id).toBeLessThanOrEqual(42);
      expect(maxRun(DAYS.map((d) => result.generatedShiftsByDay[d].some((g) => g.employeeId === e.id)), incoming.get(e.id) ?? 0), e.id).toBeLessThanOrEqual(5);
    }
  });

  it("qualification / role split (Gulf Air, 7 ACE + 1 Leader): on the day the plan rests the Leader, the Leader slot stays honestly short — never filled by an ACE", () => {
    const team = [
      ...[1, 2, 3, 4, 5, 6, 7].map((i) => makeEmployee({ id: `gf-ace-${i}`, name: `GF Ace ${i}`, assignment: "Gulf Air", team_role: "ace", foreign_company_authorizations: ["Gulf Air"] })),
      makeEmployee({ id: "gf-leader", name: "GF Leader", assignment: "Gulf Air", team_role: "leader", foreign_company_authorizations: ["Gulf Air"] }),
    ];
    const flightDays = ["Monday", "Wednesday", "Friday", "Sunday"];
    const flights = flightDays.map((day) => makeFlight({ id: `gf-${day}`, flight_number: "GF105", airline: "Gulf Air", route: "CMN → BAH", destination: "BAH", aircraft: "Airbus A320", scheduled_departure: "09:00", day_of_week: day, flight_date: flightDateFor(WEEK, day), operator_type: "self_managed" }));
    const { generatedShiftsByDay } = generateForeignCompanyShifts(DAYS, team, flights, ["Gulf Air"], 15, WEEK, new Map(), undefined, undefined, { caps: CAPS, incomingStreakByEmployee: new Map() });
    const leaderDays = flightDays.filter((d) => generatedShiftsByDay[d].some((g) => g.employeeId === "gf-leader"));
    expect(leaderDays.length).toBe(3); // 3 x >= 11.25h fits under 42h, a 4th does not
    for (const d of flightDays) {
      const aces = generatedShiftsByDay[d].filter((g) => g.employeeId.startsWith("gf-ace-")).length;
      expect(aces, d).toBeLessThanOrEqual(7);
      expect(generatedShiftsByDay[d].filter((g) => g.employeeId === "gf-leader").length, d).toBeLessThanOrEqual(1);
    }
  });

  it("the whole real stress week: every Profiling/Mesure/foreign-company member stays <= 42h, <= 5 consecutive days, >= 15h rest", () => {
    const p = stressPlan(true);
    const ids = EMPLOYEES.filter((e) => e.active && (PROF_MESURE_IDS.has(e.id) || e.foreign_company_authorizations.includes(e.assignment))).map((e) => e.id);
    expect(ids.length).toBeGreaterThan(24);
    for (const id of ids) {
      expect(hoursOf(p.generatedShiftsByDay, id, STRESS_WEEK), id).toBeLessThanOrEqual(42);
      expect(maxRun(DAYS.map((d) => p.generatedShiftsByDay[d].some((g) => g.employeeId === id))), id).toBeLessThanOrEqual(5);
    }
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
  it("Air France with a 4-person team (3 needed daily, 16 legal person-days < 21): BEFORE, the team caps out together and Sunday is 0/3; AFTER, every flight day keeps at least 2", () => {
    const ids = new Set(["af-0", "af-1", "af-2", "af-3"]);
    const covered = (r: ReturnType<typeof runAirFrance>["result"], d: string) => new Set(r.generatedShiftsByDay[d].filter((g) => g.coversRoles.includes("Air France") && ids.has(g.employeeId)).map((g) => g.employeeId)).size;
    const before = runAirFrance(4, false).result;
    expect(covered(before, "Sunday")).toBe(0);
    const after = runAirFrance(4, true).result;
    const perDay = DAYS.map((d) => covered(after, d));
    expect(Math.min(...perDay)).toBeGreaterThanOrEqual(2);
    expect(perDay.reduce((x, y) => x + y, 0)).toBe(DAYS.reduce((n, d) => n + covered(before, d), 0));
    for (const c of after.conflicts) expect(c).toMatchObject({ team: "Air France", needed: 3, covered: 2 });
  });

  it("the REAL 2026-09-07 heavy week: Gulf Air (8 members, 8 needed on 5 flight days) goes from 8/8/8/8/0 to an even 7/6/6/6/7 — same 32 legal person-days", () => {
    const gulfIds = new Set(EMPLOYEES.filter((e) => e.active && e.assignment === "Gulf Air").map((e) => e.id));
    const gen = (specializedCapPacing: boolean) => generateDraftWeeklyPlan(heavyFlights, EMPLOYEES, [], CONFIG, DAYS, "W", HEAVY_WEEK, new Map(), "unknown", { specializedCapPacing });
    const flightDaysOf = (p: DraftWeeklyPlan) => DAYS.map((d) => p.generatedShiftsByDay[d].filter((g) => gulfIds.has(g.employeeId) && g.coversRoles.includes("Gulf Air")).length);
    const before = flightDaysOf(gen(false));
    expect(before).toEqual([8, 0, 8, 0, 8, 8, 0]); // Sunday is a flight day with nobody left under the cap
    const on = gen(true);
    const after = flightDaysOf(on);
    expect(after).toEqual([7, 0, 6, 0, 6, 6, 7]);
    expect(after.reduce((x, y) => x + y, 0)).toBe(before.reduce((x, y) => x + y, 0));
    for (const id of gulfIds) expect(hoursOf(on.generatedShiftsByDay, id, HEAVY_WEEK), id).toBeLessThanOrEqual(42);
    const sunday = on.configurationIssues.find((c) => c.requirementId === "specialized-demand-conflict-Gulf Air-Sunday")!;
    expect(sunday.description).toContain("but only 7 could be legally covered within the hard work caps");
    expect(sunday.description).toContain("cap-paced rest planning");
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
