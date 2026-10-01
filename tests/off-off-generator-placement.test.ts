import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { generateProfilingMesureShifts, generateForeignCompanyShifts, SpecializedOffDayRules } from "../lib/planning/specialized-team-generation";
import { generateDraftWeeklyPlan } from "../lib/planning/generate-draft-plan";
import { aggregateDailyDemand } from "../lib/planning/demand-aggregation";
import { resolveHardWorkCaps } from "../lib/planning/hard-work-caps";
import { planDemandAwareOffWindows, planPreferredOffWindows } from "../lib/planning/off-window";
import { repairSlotPopulationGaps, breaksOffDayRules, RepairSlotAssignment, RepairSlotGroup, SlotRepairInput } from "../lib/planning/hard-cap-repair";
import { maxConsecutiveOffCyclic } from "../lib/planning/consecutive-off";
import { validateImportFile } from "../lib/flight-import";
import { flightDateFor } from "../lib/flight-date";
import { EMPLOYEES, CONFIG, FLIGHTS, CURRENT_WEEK_START } from "../lib/seed-data";
import { shiftCatalogForDate, getShiftTimesAs } from "../lib/shift-templates";
import { restHoursBetween } from "../lib/roster-generation";
import { Employee, Flight, StaffingRequirement } from "../lib/types";
import type { GeneratedShiftAssignment } from "../lib/planning/shift-generation";

/**
 * OFF/OFF PHASE 2 (2026-09-29) — the GENERATORS now place OFF days.
 *
 * Phase 1 made "fewer than minimum_off_days_per_planning_week OFF days" and
 * "OFF days not one consecutive block" HARD validation findings. It did not
 * touch the generators, so the reported roster (Ayoub Chafik, Profiling,
 * week of 2026-10-05: ONE OFF day) was flagged but still produced. These
 * tests run the real generators and assert on their OUTPUT:
 *   A. Profiling/Mesure get a demand-aware consecutive OFF window that is a
 *      hard exclusion (generateProfilingMesureShifts had no OFF machinery);
 *   B. foreign-company members' top-up receives a real demand-aware window
 *      (preferredOffWindowStart used to be undefined);
 *   C. the slot gap repair never splits an OFF/OFF pair when a legal
 *      alternative exists, and reports the gap when none does;
 *   D. a genuinely infeasible week yields honest gaps, never a fabricated
 *      roster and never a crash.
 */

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const CAPS = resolveHardWorkCaps(CONFIG);
const RULES = (): SpecializedOffDayRules => ({
  minimumOffDaysPerWeek: CONFIG.minimum_off_days_per_planning_week,
  normalWeeklyOffDays: CONFIG.normal_weekly_off_days,
  consecutive: CONFIG.normal_off_days_consecutive,
  windowsOut: new Map(),
});

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "emp", name: "Test", skills: ["Profiling"], assignment: "Profiling",
    shift_code: null, shift_start: null, shift_end: null, rest_before_shift_hours: 24,
    weekly_hours: 30, is_duty_officer: false, off_days: [], foreign_company_authorizations: [],
    active: true, weekly_shifts: [],
    ...overrides,
  };
}

function makeFlight(week: string, overrides: Partial<Flight>): Flight {
  return {
    id: "f1", flight_number: "AT201", airline: "Royal Air Maroc", route: "CMN → CDG",
    origin: "CMN", destination: "CDG", aircraft: "Boeing 737-800", equipment_code: null,
    registration: null, callsign: null, terminal: "T1", scheduled_departure: "14:30",
    scheduled_arrival: null, gate: null, boarding_window_start: null, boarding_window_end: null,
    status: "scheduled", booking_pressure: "normal", day_of_week: "Monday", flight_date: week, week_start: week,
    operator_type: "atlas_managed", destination_category: "Europe/Schengen",
    booked_passengers: null, seat_capacity: null,
    ...overrides,
  };
}

/** A Profiling team of `size`, one RAM flight per departure per day, each needing `need` Profiling agents. */
function profilingWeek(week: string, size: number, need: number, departures: string[]) {
  const pool = Array.from({ length: size }, (_, i) => makeEmployee({ id: `p-${String(i).padStart(2, "0")}`, name: `P ${i}` }));
  const flights = DAYS.flatMap((day) => departures.map((dep, k) => makeFlight(week, { id: `ram-${day}-${k}`, day_of_week: day, flight_date: flightDateFor(week, day), scheduled_departure: dep })));
  const reqs: StaffingRequirement[] = flights.map((f) => ({
    id: `r-${f.id}`, flight_id: f.id, role: "Profiling", baseline_requirement: need, additional_requirement: 0,
    total_requirement: need, source: "fixed_rule", reasoning: "", needs_configuration: false,
  }));
  return { pool, demandByDay: Object.fromEntries(DAYS.map((d) => [d, aggregateDailyDemand(d, flights, reqs)])) };
}

/** OFF-day pattern for one employee ("W"/"O" per day). */
function pattern(byDay: Record<string, GeneratedShiftAssignment[]>, id: string): string {
  return DAYS.map((d) => ((byDay[d] ?? []).some((g) => g.employeeId === id) ? "W" : "O")).join("");
}
const offCount = (p: string) => [...p].filter((c) => c === "O").length;
const longestOffRun = (p: string) => maxConsecutiveOffCyclic([...p].map((c) => ({ status: c === "O" ? ("off" as const) : ("working" as const) })));

// ---------------------------------------------------------------------------

describe("the generalized window planner", () => {
  it("planPreferredOffWindows is now a wrapper over planDemandAwareOffWindows: identical windows for the same headcount estimate", () => {
    const flex = [1, 2, 3, 4, 5].map((i) => makeEmployee({ id: `f-${i}`, assignment: "General T1 Pool", skills: ["Gate"] }));
    const viaWrapper = planPreferredOffWindows({ daysOrder: DAYS, weekStart: "2026-10-05", employees: flex, demandByDay: {}, offDaysTarget: 2, roles: ["Gate"] });
    const viaCore = planDemandAwareOffWindows({ daysOrder: DAYS, employeeIds: flex.map((e) => e.id), requiredByDay: DAYS.map(() => 0), offDaysTarget: 2 }).windows;
    expect(viaWrapper).toEqual(viaCore);
  });

  it("deficit refinement (opt-in): an exactly-feasible week (7 people, 5 needed daily) is tiled with zero deficit, where the plain greedy leaves a one-person gap", () => {
    const input = { daysOrder: DAYS, employeeIds: [0, 1, 2, 3, 4, 5, 6].map((i) => `e-${i}`), requiredByDay: DAYS.map(() => 5), offDaysTarget: 2 };
    expect(planDemandAwareOffWindows(input).deficit).toBe(1); // the shared greedy (unchanged for Stage 6)
    const refined = planDemandAwareOffWindows({ ...input, refineDeficit: true });
    expect(refined.deficit).toBe(0);
    expect(refined.remainingOffCapacity).toEqual(DAYS.map(() => 0));
  });
});

// ---------------------------------------------------------------------------

describe("A — Profiling/Mesure: the reported Chafik week now gets real OFF/OFF blocks from the generator itself", () => {
  const STRESS_WEEK = "2026-10-05";
  const csv = readFileSync(join(__dirname, "fixtures", "atlas_stress_week_2026-10-05.csv"), "utf-8");
  const flights = validateImportFile(csv, new Set(), STRESS_WEEK).filter((r) => r.flight !== null).map((r) => r.flight!);
  const plan = generateDraftWeeklyPlan(flights, EMPLOYEES, [], CONFIG, DAYS, "Week of Oct 5 2026", STRESS_WEEK, new Map(), "unknown");
  const ayoub = EMPLOYEES.find((e) => e.name === "Ayoub Chafik")!;
  const profMesure = EMPLOYEES.filter((e) => e.active && (e.assignment === "Profiling" || e.assignment === "Mesure"));

  it("the fixture really is the reported employee: Ayoub Chafik, Profiling", () => {
    expect(ayoub).toBeDefined();
    expect(ayoub.assignment).toBe("Profiling");
  });

  it("REPORTED BUG, same demand, generator called directly: without the OFF rules (the pre-phase-2 generator) Ayoub gets ONE OFF day; with them, exactly two, consecutive", () => {
    const demandByDay = Object.fromEntries(DAYS.map((d) => [d, aggregateDailyDemand(d, flights, plan.requirements, CONFIG.checkin_demand_policy)]));
    const hardCaps = { caps: CAPS, incomingStreakByEmployee: new Map<string, number>() };
    const before = generateProfilingMesureShifts(DAYS, EMPLOYEES, demandByDay, CONFIG.minimum_rest_hours, STRESS_WEEK, new Map(), hardCaps);
    expect(offCount(pattern(before.generatedShiftsByDay, ayoub.id))).toBe(1);
    const rules = RULES();
    const after = generateProfilingMesureShifts(DAYS, EMPLOYEES, demandByDay, CONFIG.minimum_rest_hours, STRESS_WEEK, new Map(), hardCaps, rules);
    const p = pattern(after.generatedShiftsByDay, ayoub.id);
    expect(offCount(p)).toBe(2);
    expect(longestOffRun(p)).toBe(2);
    // ...and they are exactly the window the planner gave him (the hard exclusion held).
    expect(DAYS.filter((_, i) => p[i] === "O")).toEqual(DAYS.filter((d) => rules.windowsOut!.get(ayoub.id)!.has(d)));
  });

  it("full pipeline: every Profiling/Mesure member has at least the floor and one complete consecutive block; no insufficient_off_days finding remains for them", () => {
    for (const e of profMesure) {
      const p = pattern(plan.generatedShiftsByDay, e.id);
      expect(offCount(p), `${e.name} ${p}`).toBeGreaterThanOrEqual(CONFIG.minimum_off_days_per_planning_week);
      expect(longestOffRun(p), `${e.name} ${p}`).toBeGreaterThanOrEqual(CONFIG.minimum_off_days_per_planning_week);
    }
    const ids = new Set(profMesure.map((e) => e.id));
    expect(plan.issues.filter((i) => i.type === "insufficient_off_days" && ids.has(i.employeeId!))).toEqual([]);
    expect(plan.issues.some((i) => i.type === "insufficient_off_days" && i.employeeId === ayoub.id)).toBe(false);
  });

  it("the coverage this costs is reported honestly: BLOCKING conflicts that name the members held OFF by their protected block", () => {
    const blocking = plan.configurationIssues.filter((c) => c.requirementId.startsWith("specialized-demand-conflict-Profiling-") || c.requirementId.startsWith("specialized-demand-conflict-Mesure-"));
    expect(blocking.length).toBeGreaterThan(0);
    for (const c of blocking) {
      expect(c.description.startsWith("BLOCKING: ")).toBe(true);
      expect(c.description).toContain("protected weekly OFF block");
      expect(c.description).toContain("rather than silently splitting or removing anyone's OFF days");
    }
  });

  it("unit reconstruction (dense, feasible — 7 agents, 5 needed every day): every agent works exactly 5 days with one 2-day OFF block, and all demand is covered", () => {
    const { pool, demandByDay } = profilingWeek("2026-09-21", 7, 5, ["14:30"]);
    const r = generateProfilingMesureShifts(DAYS, pool, demandByDay, 15, "2026-09-21", new Map(), { caps: CAPS, incomingStreakByEmployee: new Map() }, RULES());
    expect(r.conflicts).toEqual([]);
    for (const e of pool) {
      const p = pattern(r.generatedShiftsByDay, e.id);
      expect(offCount(p), p).toBe(2);
      expect(longestOffRun(p), p).toBe(2);
    }
  });

  it("the window search respects a real incoming streak: a member entering on 4 consecutive days is not given a window that forces a 6th", () => {
    const { pool, demandByDay } = profilingWeek("2026-09-21", 7, 5, ["14:30"]);
    const rules = RULES();
    const incoming = new Map([["p-00", 4]]);
    generateProfilingMesureShifts(DAYS, pool, demandByDay, 15, "2026-09-21", new Map(), { caps: CAPS, incomingStreakByEmployee: incoming }, rules);
    const w = rules.windowsOut!.get("p-00")!;
    const start = DAYS.findIndex((d) => w.has(d) && !w.has(DAYS[(DAYS.indexOf(d) + 6) % 7]));
    expect(start === 6 || 4 + start <= CAPS.maxConsecutiveWorkDays).toBe(true);
  });

  it("sparse week: no window is forced (a lightly-demanded team keeps the original demand rotation), yet nobody can drop below the floor", () => {
    const { pool, demandByDay } = profilingWeek("2026-09-21", 6, 2, ["14:30"]);
    const hardCaps = { caps: CAPS, incomingStreakByEmployee: new Map<string, number>() };
    const without = generateProfilingMesureShifts(DAYS, pool, demandByDay, 15, "2026-09-21", new Map(), hardCaps);
    const rules = RULES();
    const withRules = generateProfilingMesureShifts(DAYS, pool, demandByDay, 15, "2026-09-21", new Map(), hardCaps, rules);
    expect(rules.windowsOut!.size).toBe(0);
    // 2026-10-01 (phase 2 follow-up): with the OFF rules supplied, the normal
    // RAM roster top-up now also runs (see section E), so the output is no
    // longer byte-equal to the rule-less call. The DEMAND rotation still is:
    // every team-demand row (coversRoles [team]) and every conflict is
    // unchanged; the top-up only adds coversRoles [] rows on idle days.
    const demandRows = (r: typeof without) => Object.fromEntries(DAYS.map((d) => [d, (r.generatedShiftsByDay[d] ?? []).filter((g) => g.coversRoles.length > 0)]));
    expect(demandRows(withRules)).toEqual(demandRows(without));
    expect(withRules.conflicts).toEqual(without.conflicts);
    for (const e of pool) expect(longestOffRun(pattern(withRules.generatedShiftsByDay, e.id))).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------

describe("B — foreign company: the roster top-up now receives a demand-aware OFF window", () => {
  const WEEK = "2026-09-21";
  const team = ["Fadwa", "Khalid", "Marouane", "Tarik", "Widad"].map((name, i) =>
    makeEmployee({ id: `af-${i}`, name: `${name} Idrissi`, assignment: "Air France", skills: ["Boarding"], foreign_company_authorizations: ["Air France"] })
  );
  // Air France (confirmed headcount 3) flies Monday, Wednesday, Friday and Sunday.
  const flights = ["Monday", "Wednesday", "Friday", "Sunday"].map((day) =>
    makeFlight(WEEK, { id: `af-${day}`, flight_number: "AF1397", airline: "Air France", route: "CMN → ORY", destination: "ORY", aircraft: "Airbus A319", scheduled_departure: "12:10", day_of_week: day, flight_date: flightDateFor(WEEK, day), operator_type: "self_managed" })
  );
  const run = (rules: SpecializedOffDayRules) => generateForeignCompanyShifts(DAYS, team, flights, ["Air France"], 15, WEEK, new Map(), CONFIG, undefined, undefined, rules);

  const offOnDay = (byDay: Record<string, GeneratedShiftAssignment[]>) => DAYS.map((d) => team.filter((e) => !(byDay[d] ?? []).some((g) => g.employeeId === e.id)).length);

  it("BEFORE (preferredOffWindowStart undefined — reproduced with the OFF plan disabled): the top-up's earliest-free-block tie-break piles OFF blocks up — 4 of the 5 members OFF on Tuesday", () => {
    const before = run({ minimumOffDaysPerWeek: 0, normalWeeklyOffDays: 0, consecutive: true });
    expect(Math.max(...offOnDay(before.generatedShiftsByDay))).toBe(4);
  });

  it("AFTER: each member's OFF days are exactly their planned window, the blocks are spread across the team, and every flight day stays fully covered", () => {
    const rules = RULES();
    const after = run(rules);
    expect(after.conflicts).toEqual([]);
    for (const e of team) {
      const p = pattern(after.generatedShiftsByDay, e.id);
      expect(offCount(p), p).toBe(2);
      expect(DAYS.filter((_, i) => p[i] === "O"), e.id).toEqual(DAYS.filter((d) => rules.windowsOut!.get(e.id)!.has(d)));
    }
    // Spread across the week instead of piled up: never more than 2 of 5 OFF on any day.
    expect(Math.max(...offOnDay(after.generatedShiftsByDay))).toBeLessThanOrEqual(2);
    for (const day of ["Monday", "Wednesday", "Friday", "Sunday"]) {
      expect(after.generatedShiftsByDay[day].filter((g) => g.coversRoles.includes("Air France")).length, day).toBe(3);
    }
  });

  it("the windows are demand-aware: no flight day has more members in their window than the team can spare (5 - 3 = 2)", () => {
    const rules = RULES();
    run(rules);
    for (const day of ["Monday", "Wednesday", "Friday", "Sunday"]) {
      expect(team.filter((e) => rules.windowsOut!.get(e.id)!.has(day)).length, day).toBeLessThanOrEqual(2);
    }
  });

  it("without a config (flight-driven roster only) nothing changes: no window, no top-up", () => {
    const a = generateForeignCompanyShifts(DAYS, team, flights, ["Air France"], 15, WEEK);
    const b = generateForeignCompanyShifts(DAYS, team, flights, ["Air France"], 15, WEEK, new Map(), undefined, undefined, undefined, RULES());
    expect(b).toEqual(a);
  });
});

// ---------------------------------------------------------------------------

describe("C — hard-cap-repair's slot gap repair never splits a protected OFF/OFF pair", () => {
  // Every need is a daytime window (09:00-14:00). X works Mon-Fri and is
  // blocked from Saturday only by the 5-consecutive-work-day cap; the
  // repair's move is "a stand-in takes X's Monday, X covers Saturday".
  //   Y1 (b-y1): works Wed-Sun, OFF exactly {Mon, Tue} — taking Monday would
  //              leave it ONE OFF day (below the floor);
  //   Y2 (c-y2): OFF {Sat, Sun, Mon} — taking Monday still leaves {Sat, Sun}.
  // Y1 has fewer rostered hours (45h vs 46h), so the search tries it FIRST.
  // Every row is a rest-legal (15h) chain on its own.
  const WEEK = "2026-09-21";
  const DAYTIME = { start: "09:00", end: "14:00" };
  const ROW: Record<string, (string | null)[]> = {
    "a-x": ["MT03", "MT03", "MT03", "MT03", "MT03", null, null],
    "b-y1": [null, null, "MT03", "MT03", "MT03", "MT03", "MT03"], // 5 x 9h = 45h
    "c-y2": [null, "JR01", "AP04", "NT01", "N8", null, null], // 12.75 + 11.5 + 12.75 + 9 = 46h
  };
  function input(ids: string[], withRules: boolean): SlotRepairInput {
    const groupsByDay: Record<string, RepairSlotGroup[]> = {};
    const assignmentsByDay: Record<string, RepairSlotAssignment[]> = {};
    DAYS.forEach((day, j) => {
      const key = `late-${day}`;
      assignmentsByDay[day] = ids.filter((id) => ROW[id][j]).map((id) => ({ employeeId: id, shiftCode: ROW[id][j]!, groupKey: key }));
      groupsByDay[day] = [{ key, window: DAYTIME, needed: assignmentsByDay[day].length + (day === "Saturday" ? 1 : 0), eligibleIds: new Set(ids) }];
    });
    return {
      population: "profiling_mesure", team: "Profiling",
      ctx: { daysOrder: DAYS, weekStart: WEEK, minimumRestHours: 15, caps: CAPS, incomingStreakByEmployee: new Map(), priorWeekBoundaryContext: new Map() },
      preferExtended: false, poolIds: ids, names: new Map(ids.map((id) => [id, id])), groupsByDay, assignmentsByDay,
      ...(withRules ? { offDayRules: { minimumOffDays: 2, consecutive: true } } : {}),
    };
  }
  const row = (res: ReturnType<typeof repairSlotPopulationGaps>, id: string) => DAYS.map((d) => (res.assignmentsByDay[d].some((a) => a.employeeId === id) ? "W" : "O")).join("");

  it("breaksOffDayRules: splitting a complete block or dropping below the floor is a break; filling a surplus OFF day is not", () => {
    const rules = { minimumOffDays: 2, consecutive: true };
    const w = "AP03";
    expect(breaksOffDayRules([null, null, w, w, w, w, w], [w, null, w, w, w, w, w], rules)).toBe(true); // below the floor
    expect(breaksOffDayRules([w, w, w, null, null, null, w], [w, w, w, null, w, null, w], rules)).toBe(true); // splits the block
    expect(breaksOffDayRules([null, null, null, w, w, w, w], [w, null, null, w, w, w, w], rules)).toBe(false); // still {Tue, Wed}
    expect(breaksOffDayRules([null, null, w, w, w, w, w], [w, null, w, w, w, w, w], undefined)).toBe(false); // no rules supplied
  });

  it("BEFORE (no OFF-day rules — the pre-phase-2 search): the first stand-in, Y1, takes Monday and is left with ONE OFF day", () => {
    const res = repairSlotPopulationGaps(input(["a-x", "b-y1", "c-y2"], false));
    expect(res.repairs.map((r) => `${r.fromEmployeeId}->${r.toEmployeeId}|${r.reassignedDay}->${r.targetDay}`)).toEqual(["a-x->b-y1|Monday->Saturday"]);
    expect(offCount(row(res, "b-y1"))).toBe(1);
  });

  it("AFTER: the non-breaking stand-in Y2 is chosen instead; Saturday is covered and nobody's OFF block is broken", () => {
    const res = repairSlotPopulationGaps(input(["a-x", "b-y1", "c-y2"], true));
    expect(res.repairs.map((r) => `${r.fromEmployeeId}->${r.toEmployeeId}|${r.reassignedDay}->${r.targetDay}`)).toEqual(["a-x->c-y2|Monday->Saturday"]);
    expect(res.assignmentsByDay["Saturday"].length).toBe(2);
    expect(row(res, "b-y1")).toBe("OOWWWWW");
    for (const id of ["a-x", "b-y1", "c-y2"]) {
      const p = row(res, id);
      expect(offCount(p), `${id} ${p}`).toBeGreaterThanOrEqual(2);
      expect(longestOffRun(p), `${id} ${p}`).toBeGreaterThanOrEqual(2);
    }
    expect(res.search.offDayRuleRejections).toBeGreaterThan(0);
  });

  it("no legal alternative (Y2 absent): the gap stays, honestly — no move applied, the rejections counted for the BLOCKING wording", () => {
    const inp = input(["a-x", "b-y1"], true);
    const res = repairSlotPopulationGaps(inp);
    expect(res.repairs).toEqual([]);
    expect(res.assignmentsByDay).toBe(inp.assignmentsByDay); // untouched
    expect(res.assignmentsByDay["Saturday"].length).toBe(1); // still one short
    expect(res.search.offDayRuleRejections).toBeGreaterThan(0);
    // Without the rules, the same input silently broke Y1's pair.
    expect(repairSlotPopulationGaps(input(["a-x", "b-y1"], false)).repairs.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("D — a genuinely infeasible week (the whole team needed every day) yields honest gaps, never a fabricated roster", () => {
  it("6 agents, 6 needed every day: nobody works a 6th day, every day's shortfall is a DemandConflict naming the members on their protected block, and the output is otherwise complete", () => {
    const { pool, demandByDay } = profilingWeek("2026-09-21", 6, 6, ["14:30"]);
    let result: ReturnType<typeof generateProfilingMesureShifts> | undefined;
    expect(() => {
      result = generateProfilingMesureShifts(DAYS, pool, demandByDay, 15, "2026-09-21", new Map(), { caps: CAPS, incomingStreakByEmployee: new Map() }, RULES());
    }).not.toThrow();
    const r = result!;
    for (const e of pool) {
      const p = pattern(r.generatedShiftsByDay, e.id);
      expect(offCount(p), p).toBe(2);
      expect(longestOffRun(p), p).toBe(2);
    }
    // 6 x 5 = 30 legal person-days against 42 needed: exactly 12 short, all reported.
    const covered = DAYS.reduce((s, d) => s + r.generatedShiftsByDay[d].length, 0);
    expect(covered).toBe(30);
    expect(r.conflicts.reduce((s, c) => s + (c.needed - c.covered), 0)).toBe(12);
    for (const c of r.conflicts) {
      expect(c.team).toBe("Profiling");
      expect(c.offDayProtected!.length).toBeGreaterThan(0);
      // the covered count is real: exactly the people rostered that day
      expect(c.covered).toBe(r.generatedShiftsByDay[c.dayOfWeek].length);
    }
  });

  it("the same infeasible shape through the full pipeline (one Profiling agent, a RAM 737 needing one every day): BLOCKING conflicts on the two protected days, and the phase-1 validator finds no OFF-day violation for the agent", () => {
    const WEEK = "2026-09-21";
    const agent = makeEmployee({ id: "prof-1", name: "Prof One" });
    const fl = DAYS.map((day) => makeFlight(WEEK, { id: `ram-${day}`, day_of_week: day, flight_date: flightDateFor(WEEK, day) }));
    const plan = generateDraftWeeklyPlan(fl, [agent], [], CONFIG, DAYS, "W", WEEK, new Map(), "unknown");
    const blocking = plan.configurationIssues.filter((c) => c.requirementId.startsWith("specialized-demand-conflict-Profiling-"));
    expect(blocking.length).toBe(2);
    for (const c of blocking) expect(c.description).toContain("Prof One");
    const p = pattern(plan.generatedShiftsByDay, "prof-1");
    expect(offCount(p)).toBe(2);
    expect(longestOffRun(p)).toBe(2);
    expect(plan.issues.filter((i) => ["insufficient_off_days", "off_days_not_consecutive"].includes(i.type))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

/**
 * OFF/OFF PHASE 2 FOLLOW-UP (2026-10-01) — Profiling/Mesure normal RAM roster
 * top-up. With the floor and the max-consecutive-OFF ceiling both at 2, a
 * member needs exactly 5 work days for a clean 2-day block. Phase 2 left the
 * day(s) their role demand did not fill idle (a 3rd OFF day, flagged
 * off_days_not_consecutive). Decision: top them up exactly like
 * foreign-company members (computeEmployeeDayCountTopUp, reused unchanged):
 * a real, rest-legal shortest-legal catalog shift with coversRoles [] —
 * rostered available capacity Stage 9 can fill with real duties the member
 * is qualified for — never a fabricated duty, and never inside the
 * protected OFF block. When no legal top-up exists, the day stays idle and
 * validation keeps flagging it.
 */
describe("E — Profiling/Mesure low-demand days are topped up with real, non-demand rostered work (foreign-company top-up mirrored)", () => {
  const STRESS_WEEK = "2026-10-05";
  const csv = readFileSync(join(__dirname, "fixtures", "atlas_stress_week_2026-10-05.csv"), "utf-8");
  const flights = validateImportFile(csv, new Set(), STRESS_WEEK).filter((r) => r.flight !== null).map((r) => r.flight!);
  const plan = generateDraftWeeklyPlan(flights, EMPLOYEES, [], CONFIG, DAYS, "Week of Oct 5 2026", STRESS_WEEK, new Map(), "unknown");
  const profMesure = EMPLOYEES.filter((e) => e.active && (e.assignment === "Profiling" || e.assignment === "Mesure"));
  const OFF_TYPES = ["insufficient_off_days", "off_days_not_consecutive", "consecutive_off_violation"];
  // Phase 2's own report: these members had a 3rd idle OFF day this week —
  // the first four split (off_days_not_consecutive), the last three as a
  // 3-day run (consecutive_off_violation).
  const PREVIOUSLY_FLAGGED = ["Marouane Chafik", "Adil Chafik", "Basma Chafik", "Mehdi Chafik", "Chaimae Chafik", "Younes Chafik", "Kenza Chafik"];
  const byName = (n: string) => EMPLOYEES.find((e) => e.name === n)!;
  const demandOnly = (byDay: Record<string, GeneratedShiftAssignment[]>) =>
    Object.fromEntries(DAYS.map((d) => [d, (byDay[d] ?? []).filter((g) => g.coversRoles.length > 0)]));

  it("BEFORE (the demand-driven roster alone, i.e. phase 2's output): each previously-flagged member works only 4 days with 3 OFF days", () => {
    const demand = demandOnly(plan.generatedShiftsByDay);
    for (const name of PREVIOUSLY_FLAGGED) {
      const p = pattern(demand, byName(name).id);
      expect(offCount(p), `${name} ${p}`).toBe(3);
    }
  });

  it("AFTER: each of them gets real top-up work on the idle day (catalog shift, coversRoles []) and lands on exactly 5 work / 2 consecutive OFF, with no OFF-day finding", () => {
    for (const name of PREVIOUSLY_FLAGGED) {
      const e = byName(name);
      const p = pattern(plan.generatedShiftsByDay, e.id);
      expect(offCount(p), `${name} ${p}`).toBe(2);
      expect(longestOffRun(p), `${name} ${p}`).toBe(2);
      const topUps = DAYS.flatMap((d) => (plan.generatedShiftsByDay[d] ?? []).filter((g) => g.employeeId === e.id && g.coversRoles.length === 0));
      expect(topUps.length, name).toBeGreaterThan(0);
      for (const g of topUps) expect(shiftCatalogForDate(flightDateFor(STRESS_WEEK, g.dayOfWeek))[g.shiftCode], `${name} ${g.dayOfWeek}`).toBeDefined();
      expect(plan.issues.filter((i) => i.employeeId === e.id && OFF_TYPES.includes(i.type)), name).toEqual([]);
    }
  });

  it("whole team, full pipeline: every Profiling/Mesure member is now 5 work / 2 consecutive OFF on the stress week, rest still holds, and the BLOCKING demand conflicts are unchanged from phase 2 (top-up claims no demand)", () => {
    for (const e of profMesure) {
      const p = pattern(plan.generatedShiftsByDay, e.id);
      expect(offCount(p), `${e.name} ${p}`).toBe(2);
      expect(longestOffRun(p), `${e.name} ${p}`).toBe(2);
    }
    const ids = new Set(profMesure.map((e) => e.id));
    expect(plan.issues.filter((i) => ids.has(i.employeeId!) && OFF_TYPES.includes(i.type))).toEqual([]);
    expect(plan.issues.filter((i) => i.type === "rest_violation")).toEqual([]);
    // Same week through the generator directly: top-up rows exist, all of
    // them non-demand (coversRoles []) — DemandConflicts are computed from
    // team-demand rows only, before the top-up runs, so it can never mask one.
    const demandByDay = Object.fromEntries(DAYS.map((d) => [d, aggregateDailyDemand(d, flights, plan.requirements, CONFIG.checkin_demand_policy)]));
    const hardCaps = { caps: CAPS, incomingStreakByEmployee: new Map<string, number>() };
    const r = generateProfilingMesureShifts(DAYS, EMPLOYEES, demandByDay, CONFIG.minimum_rest_hours, STRESS_WEEK, new Map(), hardCaps, RULES());
    const topUpRows = DAYS.flatMap((d) => r.generatedShiftsByDay[d].filter((g) => g.coversRoles.length === 0));
    expect(topUpRows.length).toBeGreaterThan(0);
    const blocking = plan.configurationIssues.filter((c) => /^specialized-demand-conflict-(Profiling|Mesure)-/.test(c.requirementId));
    // 3 = exactly what phase 2's output (HEAD 124a517, no top-up) produced
    // on this week: the top-up never adds or removes demand coverage.
    expect(blocking.length).toBe(3);
  });

  it("unit (dense week, windows active — 7 agents, 6 needed Mon-Fri and 1 at the weekend): the 3 idle person-days are topped up, every agent's OFF days are EXACTLY their planned window, and no demand is lost", () => {
    const W = "2026-09-21";
    const pool = Array.from({ length: 7 }, (_, i) => makeEmployee({ id: `p-${i}`, name: `P ${i}` }));
    const need: Record<string, number> = { Monday: 6, Tuesday: 6, Wednesday: 6, Thursday: 6, Friday: 6, Saturday: 1, Sunday: 1 };
    const fl = DAYS.map((d) => makeFlight(W, { id: `ram-${d}`, day_of_week: d, flight_date: flightDateFor(W, d) }));
    const reqs: StaffingRequirement[] = fl.map((f) => ({
      id: `r-${f.id}`, flight_id: f.id, role: "Profiling", baseline_requirement: need[f.day_of_week], additional_requirement: 0,
      total_requirement: need[f.day_of_week], source: "fixed_rule", reasoning: "", needs_configuration: false,
    }));
    const demandByDay = Object.fromEntries(DAYS.map((d) => [d, aggregateDailyDemand(d, fl, reqs)]));
    const rules = RULES();
    const r = generateProfilingMesureShifts(DAYS, pool, demandByDay, 15, W, new Map(), { caps: CAPS, incomingStreakByEmployee: new Map() }, rules);
    expect(rules.windowsOut!.size).toBe(7); // dense regime: phase 2's hard windows are in force
    expect(r.conflicts).toEqual([]);
    const demand = demandOnly(r.generatedShiftsByDay);
    expect(DAYS.reduce((s, d) => s + demand[d].length, 0)).toBe(32); // all demand covered by team-demand rows
    let topUps = 0;
    for (const e of pool) {
      const p = pattern(r.generatedShiftsByDay, e.id);
      expect(offCount(p), `${e.id} ${p}`).toBe(2);
      expect(DAYS.filter((_, i) => p[i] === "O"), e.id).toEqual(DAYS.filter((d) => rules.windowsOut!.get(e.id)!.has(d)));
      topUps += DAYS.filter((d) => r.generatedShiftsByDay[d].some((g) => g.employeeId === e.id && g.coversRoles.length === 0)).length;
    }
    expect(topUps).toBe(35 - 32); // 7 x 5 work days minus the 32 demand person-days
  });

  it("the top-up day is real, assignable capacity: on the demo week Stage 9 gives real team duties to members on their topped-up days", () => {
    const demo = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS, "W", CURRENT_WEEK_START);
    const pmIds = new Set(profMesure.map((e) => e.id));
    const onTopUpDay = DAYS.flatMap((d) =>
      demo.dutiesByDay[d].filter((duty) => pmIds.has(duty.employeeId) && demo.generatedShiftsByDay[d].some((g) => g.employeeId === duty.employeeId && g.coversRoles.length === 0))
    );
    expect(onTopUpDay.length).toBeGreaterThan(0);
    for (const duty of onTopUpDay) expect(EMPLOYEES.find((e) => e.id === duty.employeeId)!.skills).toContain(duty.role);
  });
});

describe("F — honest fallback: when no legal top-up exists the day stays idle and is still flagged (never fabricated)", () => {
  // One Profiling agent. Monday's late RAM flight (21:30) puts them on an
  // evening code; Wednesday's 07:00 flight on an early one. With the 15h
  // minimum on both sides, NO catalog code fits Tuesday: the top-up has no
  // real work to give, so Tuesday must stay idle and the split OFF days
  // (Tuesday + the protected Saturday/Sunday block) must still be flagged.
  const WEEK = "2026-09-21";
  const agent = makeEmployee({ id: "prof-1", name: "Prof One" });
  const fl = [
    makeFlight(WEEK, { id: "mon", day_of_week: "Monday", flight_date: flightDateFor(WEEK, "Monday"), scheduled_departure: "21:30" }),
    makeFlight(WEEK, { id: "wed", day_of_week: "Wednesday", flight_date: flightDateFor(WEEK, "Wednesday"), scheduled_departure: "07:00" }),
    makeFlight(WEEK, { id: "thu", day_of_week: "Thursday", flight_date: flightDateFor(WEEK, "Thursday") }),
    makeFlight(WEEK, { id: "fri", day_of_week: "Friday", flight_date: flightDateFor(WEEK, "Friday") }),
  ];
  const plan = generateDraftWeeklyPlan(fl, [agent], [], CONFIG, DAYS, "W", WEEK, new Map(), "unknown");

  it("Tuesday has no rest-legal code at all between Monday's and Wednesday's real shifts", () => {
    const mon = plan.generatedShiftsByDay["Monday"].find((g) => g.employeeId === "prof-1")!;
    const wed = plan.generatedShiftsByDay["Wednesday"].find((g) => g.employeeId === "prof-1")!;
    const tue = flightDateFor(WEEK, "Tuesday");
    const m = getShiftTimesAs(mon.shiftCode, flightDateFor(WEEK, "Monday"));
    const w = getShiftTimesAs(wed.shiftCode, flightDateFor(WEEK, "Wednesday"));
    const legal = Object.entries(shiftCatalogForDate(tue)).filter(
      ([, t]) => restHoursBetween(m.shift_start, m.shift_end, t.entree) >= 15 && restHoursBetween(t.entree, t.sortie, w.shift_start) >= 15
    );
    expect(legal).toEqual([]);
  });

  it("the agent works 4 days (no fabricated Tuesday row, and the reserved Saturday/Sunday block is NOT used to make up the count) and the split is flagged off_days_not_consecutive", () => {
    const p = pattern(plan.generatedShiftsByDay, "prof-1");
    expect(p).toBe("WOWWWOO");
    expect(plan.generatedShiftsByDay["Tuesday"].some((g) => g.employeeId === "prof-1")).toBe(false);
    expect(plan.issues.filter((i) => i.employeeId === "prof-1" && OFF_DAY_FINDINGS.includes(i.type)).map((i) => i.type)).toEqual(["off_days_not_consecutive"]);
    expect(plan.issues.filter((i) => i.type === "rest_violation")).toEqual([]);
  });
});
const OFF_DAY_FINDINGS = ["insufficient_off_days", "off_days_not_consecutive", "consecutive_off_violation"];
