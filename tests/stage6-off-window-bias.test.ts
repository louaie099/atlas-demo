import { describe, it, expect } from "vitest";
import { generateFlexiblePoolShifts, PriorDayShiftMap } from "../lib/planning/shift-generation";
import { generateDraftWeeklyPlan } from "../lib/planning/generate-draft-plan";
import { generateObligationToppedUpShifts, chooseTopUpReservedOffDays } from "../lib/planning/roster-generation";
import { aggregateDailyDemand } from "../lib/planning/demand-aggregation";
import {
  planPreferredOffWindows,
  chooseBestCyclicWindowStart,
  startForcesPreviousDayOff,
  countOffWindowStructureConflicts,
  Stage6OffWindowContext,
} from "../lib/planning/off-window";
import {
  stage6CandidateScore,
  stage6CoverageScore,
  HARD_COVERAGE_UNIT,
  T1_DEMAND_BIAS_WEIGHT,
  OFF_WINDOW_STRUCTURE_CONFLICT_WEIGHT,
  OFF_WINDOW_STRUCTURE_MAX_TOTAL,
  MAX_OFF_WINDOW_STRUCTURE_CONFLICTS,
  FATIGUE_TIER_BUDGET,
  STAGE6_BUCKETS_PER_DAY,
} from "../lib/planning/stage6-score-tiers";
import { checkSeparatedOffDays } from "../lib/planning/validation";
import { maxConsecutiveOffCyclic } from "../lib/planning/consecutive-off";
import { isFlexibleGeneralPool } from "../lib/planning/workforce-pools";
import { usesFixedCycleRotation } from "../lib/teams";
import { EMPLOYEES, FLIGHTS, CONFIG as SEED_CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_START } from "../lib/seed-data";
import { Employee, Flight, StaffingRequirement } from "../lib/types";

// HARD-CAPS FIXTURE ADJUSTMENT (2026-09-25, hard-constraints milestone
// phase 1): these tests pin the OFF/OFF structure mechanism under the
// confirmed "5 WORK + 2 OFF" target. The new hard_weekly_hours_cap
// defaults to 42h, and 5 x the shortest catalog code (NR01, 8.75h/9h) =
// 43.75h/45h > 42h — so with the default cap a 5-work-day week is
// arithmetically impossible for ANY generation-driven employee and these
// tests could no longer observe the mechanism they exist for. The hours cap
// is pinned non-binding HERE ONLY; the 5-consecutive-work-day cap stays at
// its real default (compatible with 5 WORK + 2 OFF). The caps' own
// behaviour, and their interaction with this target (reported as a
// structural finding), is tested in tests/hard-work-caps.test.ts.
const CONFIG = { ...SEED_CONFIG, hard_weekly_hours_cap: 999 };

/**
 * OFF/OFF milestone part A (2026-09-24): Stage 6 used to have zero
 * awareness of a flexible ACE's weekly consecutive OFF block, so "OFF"
 * was whatever Stage 6 happened not to need, and Stage 6.5's top-up could
 * only pick a consecutive block among the leftovers. These tests pin:
 *   - the score-tier hierarchy (hard coverage > T1 > OFF/OFF structure >
 *     reserved fatigue budget), as a formula invariant;
 *   - that coverage and 15h rest always win over structure;
 *   - that the fix produces 5 WORK + 2 CONSECUTIVE OFF in a scenario the
 *     old Stage 6 split, and measurably reduces separation on seed data;
 *   - that separation still happens, legally and flagged, when coverage
 *     genuinely forces it;
 *   - that different demand shapes produce different OFF placements;
 *   - that fixed-cycle / non-flexible employees are untouched.
 */

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const PRE_REGIME_WEEK = "2026-08-31"; // CURRENT_WEEK_START — before the 2026-09-20 regime change
const POST_REGIME_WEEK = "2026-09-21";

function makeAce(id: string, skills: string[]): Employee {
  return {
    id, name: id, skills, assignment: "General T1 Pool",
    shift_code: null, shift_start: null, shift_end: null, rest_before_shift_hours: 24, weekly_hours: 0,
    is_duty_officer: false, off_days: [], foreign_company_authorizations: [], active: true,
    weekly_shifts: DAYS.map((d) => ({ day_of_week: d, shift_code: null, status: "off" as const })),
  };
}

function makeFlight(day: string, weekStart: string, index: number, departure = "10:00"): Flight {
  return {
    id: `f-${day}-${index}`, flight_number: `AT${100 + index}`, airline: "Royal Air Maroc", route: "CMN → X",
    origin: "CMN", destination: "X", aircraft: "Boeing 737-800", equipment_code: null, registration: null,
    callsign: null, terminal: "T1", scheduled_departure: departure, scheduled_arrival: null, gate: null,
    boarding_window_start: null, boarding_window_end: null, status: "scheduled", booking_pressure: "normal",
    day_of_week: day, flight_date: weekStart, week_start: weekStart, operator_type: "atlas_managed",
    destination_category: "Europe/Schengen", booked_passengers: null, seat_capacity: null,
  };
}

function patternFor(plan: ReturnType<typeof generateDraftWeeklyPlan>, employeeId: string): string {
  return DAYS.map((d) => (plan.rosterEntries.find((r) => r.employee_id === employeeId && r.day_of_week === d)!.status === "working" ? "W" : "O")).join("");
}

function isFiveWorkTwoConsecutiveOff(pattern: string): boolean {
  const offCount = (pattern.match(/O/g) ?? []).length;
  if (offCount !== 2) return false;
  return maxConsecutiveOffCyclic([...pattern].map((c) => ({ status: c === "O" ? ("off" as const) : ("working" as const) }))) === 2;
}

function offDays(pattern: string): string[] {
  return DAYS.filter((_, i) => pattern[i] === "O");
}

describe("Stage-6 score tiers — the epsilon-nested hierarchy is provable from the formula itself", () => {
  it("tier magnitudes nest strictly: 48*T1 < 1 hard unit; full structure tier < 1 T1 bucket; fatigue budget < 1 structural conflict", () => {
    expect(STAGE6_BUCKETS_PER_DAY * T1_DEMAND_BIAS_WEIGHT).toBeLessThan(HARD_COVERAGE_UNIT);
    expect(OFF_WINDOW_STRUCTURE_MAX_TOTAL).toBeLessThan(T1_DEMAND_BIAS_WEIGHT);
    expect(FATIGUE_TIER_BUDGET).toBeLessThan(OFF_WINDOW_STRUCTURE_CONFLICT_WEIGHT);
  });

  it("hard coverage ALWAYS dominates: one more hard bucket beats any T1 + best structure, for every combination", () => {
    for (let hard = 0; hard < STAGE6_BUCKETS_PER_DAY; hard++) {
      for (let t1 = 0; t1 <= STAGE6_BUCKETS_PER_DAY; t1++) {
        // Worst possible case for the "more hard coverage" candidate: zero
        // T1, maximum structural conflicts. Best possible case for the
        // other: maximum T1, zero conflicts.
        const moreHardWorstStructure = stage6CandidateScore(hard + 1, 0, MAX_OFF_WINDOW_STRUCTURE_CONFLICTS);
        const lessHardBestEverythingElse = stage6CandidateScore(hard, t1, 0);
        expect(moreHardWorstStructure).toBeGreaterThan(lessHardBestEverythingElse);
      }
    }
  });

  it("required-coverage refinement (T1) outranks roster structure: one more T1 bucket beats any structural advantage at equal hard coverage", () => {
    for (let hard = 0; hard <= 5; hard++) {
      for (let t1 = 0; t1 < STAGE6_BUCKETS_PER_DAY; t1++) {
        if (hard === 0 && t1 === 0) continue; // a non-covering candidate is never scored
        expect(stage6CandidateScore(hard, t1 + 1, MAX_OFF_WINDOW_STRUCTURE_CONFLICTS)).toBeGreaterThan(stage6CandidateScore(hard, t1, 0));
      }
    }
  });

  it("among coverage-equivalent candidates, fewer structural conflicts wins — and the reserved fatigue budget can never flip that", () => {
    for (let conflicts = 0; conflicts < MAX_OFF_WINDOW_STRUCTURE_CONFLICTS; conflicts++) {
      const better = stage6CandidateScore(3, 7, conflicts);
      const worse = stage6CandidateScore(3, 7, conflicts + 1);
      expect(better).toBeGreaterThan(worse);
      // Even if a future fatigue term gave the worse-structured candidate
      // its entire budget and the better one nothing, structure still wins.
      expect(better).toBeGreaterThan(worse + FATIGUE_TIER_BUDGET);
    }
  });

  it("the structure tier can never turn a covering candidate into a non-candidate, nor a non-covering one into a candidate", () => {
    // Smallest positive coverage = one T1 bucket; full structure penalty keeps it > 0.
    expect(stage6CandidateScore(0, 1, MAX_OFF_WINDOW_STRUCTURE_CONFLICTS)).toBeGreaterThan(0);
    expect(stage6CandidateScore(0, 0, MAX_OFF_WINDOW_STRUCTURE_CONFLICTS)).toBe(0);
    expect(stage6CandidateScore(0, 0, 0)).toBe(0);
    // Structure is clamped — a bogus conflict count cannot exceed the bounded tier.
    expect(stage6CandidateScore(1, 0, 99)).toBe(stage6CandidateScore(1, 0, MAX_OFF_WINDOW_STRUCTURE_CONFLICTS));
    expect(stage6CoverageScore(2, 3)).toBe(2 * HARD_COVERAGE_UNIT + 3 * T1_DEMAND_BIAS_WEIGHT);
  });
});

describe("Stage 6 with a preferred-OFF-window context — coverage and 15h rest are never traded for structure", () => {
  const WEDNESDAY_DATE = "2026-09-02"; // pre-regime
  // One Gate requirement departing 05:30 -> window 04:30-05:30: only the
  // 04:30-start codes (MT02/JR02) cover it.
  const earlyGateFlight = makeFlight("Wednesday", PRE_REGIME_WEEK, 1, "05:30");
  const earlyGateReq: StaffingRequirement = {
    id: "r-gate", flight_id: earlyGateFlight.id, role: "Gate", baseline_requirement: 1, additional_requirement: 0,
    total_requirement: 1, source: "fixed_rule", reasoning: "", needs_configuration: false,
  };
  const demand = aggregateDailyDemand("Wednesday", [earlyGateFlight], [earlyGateReq]);

  const insideWindow = makeAce("a-in-window", ["Gate"]);
  const outsideWindow = makeAce("b-outside-window", ["Gate"]);
  const context: Stage6OffWindowContext = {
    preferredOffDaysByEmployee: new Map([
      [insideWindow.id, new Set(["Wednesday", "Thursday"])],
      [outsideWindow.id, new Set(["Saturday", "Sunday"])],
    ]),
  };

  it("sanity: with everyone rested and coverage-equivalent, the bias really does steer the pick away from the employee whose OFF window today is", () => {
    const noBias = generateFlexiblePoolShifts("Wednesday", WEDNESDAY_DATE, demand, [insideWindow, outsideWindow], new Map(), 15);
    // Without the context, pure id tie-break picks "a-in-window".
    expect(noBias.map((g) => g.employeeId)).toEqual(["a-in-window"]);

    const withBias = generateFlexiblePoolShifts(
      "Wednesday", WEDNESDAY_DATE, demand, [insideWindow, outsideWindow], new Map(), 15, undefined, new Map(), new Map(), undefined, context
    );
    expect(withBias.map((g) => g.employeeId)).toEqual(["b-outside-window"]);
  });

  it("15h rest stays HARD: when the structurally-preferred employee is not rest-legal for the only covering code, the in-window employee is rostered instead — never the illegal one", () => {
    // b worked NR02 (08:00-18:15) yesterday: 18:15 -> 04:30 is 10.25h < 15h,
    // so MT02/JR02 are illegal for b. The structure tier would prefer b.
    const priorDayShift: PriorDayShiftMap = new Map([[outsideWindow.id, { shift_start: "08:00", shift_end: "18:15" }]]);
    const result = generateFlexiblePoolShifts(
      "Wednesday", WEDNESDAY_DATE, demand, [insideWindow, outsideWindow], priorDayShift, 15, undefined, new Map(), new Map(), undefined, context
    );
    expect(result).toHaveLength(1);
    expect(result[0].employeeId).toBe("a-in-window");
    expect(["MT02", "JR02"]).toContain(result[0].shiftCode);
    expect(result.some((g) => g.employeeId === outsideWindow.id)).toBe(false);
  });

  it("coverage is never sacrificed for structure: when two simultaneous units are needed, the in-window employee is still rostered", () => {
    const twoUnitReq = { ...earlyGateReq, total_requirement: 2, baseline_requirement: 2 };
    const twoUnitDemand = aggregateDailyDemand("Wednesday", [earlyGateFlight], [twoUnitReq]);
    const result = generateFlexiblePoolShifts(
      "Wednesday", WEDNESDAY_DATE, twoUnitDemand, [insideWindow, outsideWindow], new Map(), 15, undefined, new Map(), new Map(), undefined, context
    );
    expect(result.map((g) => g.employeeId).sort()).toEqual(["a-in-window", "b-outside-window"]);
  });

  it("coverage is never sacrificed for structure: the only qualified employee is rostered on their preferred OFF day rather than leaving the requirement uncovered", () => {
    const notQualified = makeAce("b-not-qualified", ["Check-in"]);
    const ctx: Stage6OffWindowContext = {
      preferredOffDaysByEmployee: new Map([
        [insideWindow.id, new Set(["Wednesday", "Thursday"])],
        [notQualified.id, new Set(["Saturday", "Sunday"])],
      ]),
    };
    const result = generateFlexiblePoolShifts(
      "Wednesday", WEDNESDAY_DATE, demand, [insideWindow, notQualified], new Map(), 15, undefined, new Map(), new Map(), undefined, ctx
    );
    expect(result.map((g) => g.employeeId)).toEqual(["a-in-window"]);
    expect(result[0].coversRoles).toEqual(["Gate"]);
  });

  it("a candidate covering MORE hard demand wins even when today is inside its OFF window", () => {
    // Sequential Gate (04:30-05:30) + Boarding later in the morning: one
    // Gate+Boarding-qualified shift covers both; a Boarding-only employee
    // outside their window covers only one.
    const boardingFlight = makeFlight("Wednesday", PRE_REGIME_WEEK, 2, "11:00");
    const boardingReq: StaffingRequirement = { ...earlyGateReq, id: "r-board", flight_id: boardingFlight.id, role: "Boarding" };
    const mixedDemand = aggregateDailyDemand("Wednesday", [earlyGateFlight, boardingFlight], [earlyGateReq, boardingReq]);
    const multi = makeAce("a-multi-in-window", ["Gate", "Boarding"]);
    const boardingOnly = makeAce("b-boarding-only", ["Boarding"]);
    const ctx: Stage6OffWindowContext = {
      preferredOffDaysByEmployee: new Map([
        [multi.id, new Set(["Wednesday", "Thursday"])],
        [boardingOnly.id, new Set(["Saturday", "Sunday"])],
      ]),
    };
    const result = generateFlexiblePoolShifts(
      "Wednesday", WEDNESDAY_DATE, mixedDemand, [boardingOnly, multi], new Map(), 15, undefined, new Map(), new Map(), undefined, ctx
    );
    const multiAssignment = result.find((g) => g.employeeId === multi.id);
    expect(multiAssignment).toBeDefined();
    expect(multiAssignment!.coversRoles.sort()).toEqual(["Boarding", "Gate"]);
  });

  it("structural foresight: an early code that would force the previous day OFF outside the window counts as a conflict, using the REAL date-resolved catalog in both regimes", () => {
    // Nothing in either regime's non-overnight catalog ends 15h before the
    // earliest code's start, so the earliest start forces the previous day OFF.
    for (const previousDate of ["2026-09-01", "2026-09-22"]) {
      expect(startForcesPreviousDayOff(4 * 60 + 30, previousDate, 15)).toBe(true);
      expect(startForcesPreviousDayOff(13 * 60 + 45, previousDate, 15)).toBe(false);
      expect(startForcesPreviousDayOff(4 * 60 + 30, previousDate, 0)).toBe(false);
    }
    const ctx: Stage6OffWindowContext = {
      preferredOffDaysByEmployee: new Map([["x", new Set(["Thursday", "Friday"])], ["y", new Set(["Tuesday", "Wednesday"])]]),
      previousDay: { dayOfWeek: "Tuesday", date: "2026-09-01" },
      nextDay: { dayOfWeek: "Thursday", date: "2026-09-03" },
    };
    // x: Tuesday is NOT in x's window, so forcing it OFF would split x's block.
    expect(countOffWindowStructureConflicts("x", "Wednesday", true, false, ctx)).toBe(1);
    // y: Wednesday is in y's window (conflict a); forcing Tuesday OFF is harmless (Tuesday is in the window too).
    expect(countOffWindowStructureConflicts("y", "Wednesday", true, false, ctx)).toBe(1);
    // An employee with no window never has conflicts.
    expect(countOffWindowStructureConflicts("nobody", "Wednesday", true, true, ctx)).toBe(0);
  });
});

describe("full pipeline — a normal flexible ACE gets 5 WORK + 2 CONSECUTIVE OFF", () => {
  // Three Boarding/Gate ACEs, one Boeing 737-800 Europe/Schengen departure
  // at 10:00 every day (1 Gate + 1 Boarding + 1 Profiling requirement, as
  // the real staffing matrix produces). Profiling stays honestly unfilled
  // (nobody holds it) — that is not what this test is about.
  const aces = [makeAce("ace-0", ["Boarding", "Gate"]), makeAce("ace-1", ["Boarding", "Gate"]), makeAce("ace-2", ["Boarding", "Gate"])];

  for (const weekStart of [PRE_REGIME_WEEK, POST_REGIME_WEEK]) {
    const flights = DAYS.map((d, i) => makeFlight(d, weekStart, i));

    it(`(${weekStart}) BEFORE the fix Stage 6 scattered OFF days (a separated pattern); AFTER it every ACE has exactly 5 WORK + 2 consecutive OFF, with no coverage lost`, () => {
      const before = generateDraftWeeklyPlan(flights, aces, [], CONFIG, DAYS, "W", weekStart, new Map(), "unknown", { offWindowStructureBias: false });
      const after = generateDraftWeeklyPlan(flights, aces, [], CONFIG, DAYS, "W", weekStart);

      // The old Stage 6 (bias off) leaves at least one ACE with a split OFF block.
      expect(aces.some((a) => !isFiveWorkTwoConsecutiveOff(patternFor(before, a.id)))).toBe(true);
      expect(before.issues.filter((i) => i.type === "separated_off_days").length).toBeGreaterThan(0);

      for (const a of aces) expect(isFiveWorkTwoConsecutiveOff(patternFor(after, a.id))).toBe(true);
      expect(after.issues.filter((i) => i.type === "separated_off_days")).toHaveLength(0);

      // Coverage: never worse than before (only Profiling — unqualified — may stay unfilled).
      const unfilled = (p: typeof after) => p.issues.filter((i) => i.type === "unfilled_duty");
      expect(unfilled(after).length).toBeLessThanOrEqual(unfilled(before).length);
      for (const u of unfilled(after)) expect(u.description.startsWith("Profiling")).toBe(true);
      expect(after.issues.filter((i) => i.type === "rest_violation")).toHaveLength(0);
    });
  }

  it("is deterministic: identical inputs produce an identical roster", () => {
    const flights = DAYS.map((d, i) => makeFlight(d, PRE_REGIME_WEEK, i));
    const a = generateDraftWeeklyPlan(flights, aces, [], CONFIG, DAYS, "W", PRE_REGIME_WEEK);
    const b = generateDraftWeeklyPlan(flights, aces, [], CONFIG, DAYS, "W", PRE_REGIME_WEEK);
    expect(a.rosterEntries).toEqual(b.rosterEntries);
  });
});

describe("the planner actually searches OFF/OFF positions — different demand shapes, different placements", () => {
  const aces = [makeAce("ace-0", ["Boarding", "Gate"]), makeAce("ace-1", ["Boarding", "Gate"]), makeAce("ace-2", ["Boarding", "Gate"])];

  it("uniform demand spreads the three OFF blocks across the week; demand only Wednesday-Sunday puts them on the idle Monday-Tuesday", () => {
    const uniform = generateDraftWeeklyPlan(DAYS.map((d, i) => makeFlight(d, PRE_REGIME_WEEK, i)), aces, [], CONFIG, DAYS, "W", PRE_REGIME_WEEK);
    const lateWeek = generateDraftWeeklyPlan(
      DAYS.filter((d) => d !== "Monday" && d !== "Tuesday").map((d, i) => makeFlight(d, PRE_REGIME_WEEK, i)),
      aces, [], CONFIG, DAYS, "W", PRE_REGIME_WEEK
    );

    const uniformOff = aces.map((a) => offDays(patternFor(uniform, a.id)).join("+"));
    const lateWeekOff = aces.map((a) => offDays(patternFor(lateWeek, a.id)).join("+"));

    // Uniform: three DIFFERENT consecutive blocks (spread, not everyone on the same days).
    expect(new Set(uniformOff).size).toBe(3);
    // Demand-shaped: every block lands on the demand-free Monday+Tuesday.
    for (const off of lateWeekOff) expect(off).toBe("Monday+Tuesday");
    expect(uniformOff).not.toEqual(lateWeekOff);
    for (const plan of [uniform, lateWeek]) for (const a of aces) expect(isFiveWorkTwoConsecutiveOff(patternFor(plan, a.id))).toBe(true);
  });

  it("planPreferredOffWindows: a light mid-week day attracts OFF windows, a heavy one repels them (wraparound windows included)", () => {
    const pool = Array.from({ length: 6 }, (_, i) => makeAce(`p-${i}`, ["Boarding"]));
    const emptyDemand = (day: string) => aggregateDailyDemand(day, [], []);
    const flat = (n: number) => Array.from({ length: 48 }, (_, b) => (b >= 16 && b < 34 ? n : 0)); // 08:00-17:00
    const demandByDay = Object.fromEntries(DAYS.map((d) => [d, emptyDemand(d)]));

    const lightWednesday = Object.fromEntries(DAYS.map((d) => [d, flat(d === "Wednesday" || d === "Thursday" ? 0 : 4)]));
    const heavyMidweek = Object.fromEntries(DAYS.map((d) => [d, flat(["Tuesday", "Wednesday", "Thursday", "Friday"].includes(d) ? 6 : 1)]));

    const w1 = planPreferredOffWindows({ daysOrder: DAYS, weekStart: PRE_REGIME_WEEK, employees: pool, demandByDay, t1DemandByBucketByDay: lightWednesday, offDaysTarget: 2, roles: ["Boarding"] });
    const w2 = planPreferredOffWindows({ daysOrder: DAYS, weekStart: PRE_REGIME_WEEK, employees: pool, demandByDay, t1DemandByBucketByDay: heavyMidweek, offDaysTarget: 2, roles: ["Boarding"] });

    const count = (w: Map<string, ReadonlySet<string>>, day: string) => [...w.values()].filter((s) => s.has(day)).length;
    expect(count(w1, "Wednesday")).toBeGreaterThan(count(w1, "Monday"));
    expect(count(w2, "Wednesday")).toBe(0);
    // Heavy Tue-Fri pushes blocks onto Sat/Sun/Mon, including the Sun-Mon wrap.
    expect([...w2.values()].some((s) => s.has("Sunday") && s.has("Monday"))).toBe(true);
    for (const w of [w1, w2]) for (const s of w.values()) expect(s.size).toBe(2);
  });

  it("planPreferredOffWindows never gives a window to a non-flexible employee and is deterministic", () => {
    const transit = { ...makeAce("t-1", ["Boarding"]), assignment: "Transit" };
    const input = {
      daysOrder: DAYS, weekStart: PRE_REGIME_WEEK, employees: [transit, makeAce("f-1", ["Boarding"])],
      demandByDay: Object.fromEntries(DAYS.map((d) => [d, aggregateDailyDemand(d, [], [])])), offDaysTarget: 2, roles: ["Boarding"],
    };
    const a = planPreferredOffWindows(input);
    expect(a.has("t-1")).toBe(false);
    expect(a.has("f-1")).toBe(true);
    expect(planPreferredOffWindows(input)).toEqual(a);
  });

  it("planPreferredOffWindows avoids extending a KNOWN real prior-day OFF run across the week boundary", () => {
    const pool = [makeAce("p-0", ["Boarding"])];
    const demandByDay = Object.fromEntries(DAYS.map((d) => [d, aggregateDailyDemand(d, [], [])]));
    const unconstrained = planPreferredOffWindows({ daysOrder: DAYS, weekStart: PRE_REGIME_WEEK, employees: pool, demandByDay, offDaysTarget: 2, roles: ["Boarding"] });
    expect(unconstrained.get("p-0")!.has("Monday")).toBe(true); // flat demand -> earliest window, Mon-Tue
    const constrained = planPreferredOffWindows({
      daysOrder: DAYS, weekStart: PRE_REGIME_WEEK, employees: pool, demandByDay, offDaysTarget: 2, roles: ["Boarding"],
      priorDayOffEmployeeIds: new Set(["p-0"]),
    });
    expect(constrained.get("p-0")!.has("Monday")).toBe(false);
  });

  it("the shared cyclic window primitive and the top-up reservation agree: the top-up keeps the pre-planned window when it is fully free, and falls back to earliest-start without one", () => {
    const freeDays = new Set(["Tuesday", "Friday", "Saturday", "Sunday"]);
    // Original behaviour, unchanged: Fri/Sat (earliest of the tied fully-free pairs).
    expect(chooseTopUpReservedOffDays(DAYS, freeDays, 2)).toEqual(new Set(["Friday", "Saturday"]));
    // With the pre-planned Sat/Sun window as tie-break, the top-up keeps it.
    expect(chooseTopUpReservedOffDays(DAYS, freeDays, 2, 5)).toEqual(new Set(["Saturday", "Sunday"]));
    // A partially-free preferred window never beats a fully-free one.
    expect(chooseTopUpReservedOffDays(DAYS, freeDays, 2, 1)).toEqual(new Set(["Friday", "Saturday"]));
    // Wraparound Sun+Mon is a real candidate window.
    expect(chooseBestCyclicWindowStart(7, 2, (idx) => [idx.filter((i) => i === 6 || i === 0).length])).toBe(6);
  });
});

describe("separated OFF is no longer the normal-case outcome — but stays legal when genuinely forced", () => {
  it("seed-data pipeline: the fix cuts gratuitous separated_off_days by at least 75% in both shift regimes, with no new unfilled duty or rest violation", () => {
    for (const weekStart of [CURRENT_WEEK_START, POST_REGIME_WEEK]) {
      const before = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, "W", weekStart, new Map(), "unknown", { offWindowStructureBias: false });
      const after = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, "W", weekStart);
      const count = (p: typeof after, type: string) => p.issues.filter((i) => i.type === type).length;

      expect(count(before, "separated_off_days")).toBeGreaterThan(0);
      expect(count(after, "separated_off_days") * 4).toBeLessThanOrEqual(count(before, "separated_off_days"));
      expect(count(after, "unfilled_duty")).toBeLessThanOrEqual(count(before, "unfilled_duty"));
      expect(count(after, "rest_violation")).toBe(0);

      const flexible = EMPLOYEES.filter(isFlexibleGeneralPool);
      const good = (p: typeof after) => flexible.filter((e) => isFiveWorkTwoConsecutiveOff(patternFor(p, e.id))).length;
      expect(good(after)).toBeGreaterThan(good(before));
    }
  });

  it("when coverage genuinely forces it (the ONLY qualified employee is needed Mon/Wed/Fri/Sun), the result is still 5 WORK + 2 OFF, separated, fully legal, and flagged by checkSeparatedOffDays", () => {
    const solo = makeAce("solo", ["Boarding"]);
    const flights = ["Monday", "Wednesday", "Friday", "Sunday"].map((d, i) => makeFlight(d, PRE_REGIME_WEEK, i));
    const plan = generateDraftWeeklyPlan(flights, [solo], [], CONFIG, DAYS, "W", PRE_REGIME_WEEK);
    const pattern = patternFor(plan, "solo");

    for (const d of ["Monday", "Wednesday", "Friday", "Sunday"]) expect(pattern[DAYS.indexOf(d)]).toBe("W"); // coverage kept
    expect((pattern.match(/W/g) ?? []).length).toBe(5);
    expect(isFiveWorkTwoConsecutiveOff(pattern)).toBe(false); // genuinely separated

    const issue = plan.issues.find((i) => i.type === "separated_off_days" && i.employeeId === "solo");
    expect(issue).toBeDefined();
    expect(plan.issues.filter((i) => i.type === "rest_violation" || i.type === "consecutive_off_violation")).toHaveLength(0);
    expect(plan.restViolationsPrevented.filter((d) => d.employeeId === "solo")).toHaveLength(0);

    // And checkSeparatedOffDays itself reports it as the non-blocking soft issue.
    const asEmployee: Employee = { ...solo, weekly_shifts: DAYS.map((d, i) => ({ day_of_week: d, status: pattern[i] === "W" ? "working" : "off", shift_code: null })) };
    expect(checkSeparatedOffDays(asEmployee, DAYS, CONFIG)?.type).toBe("separated_off_days");
  });

  it("the top-up (unit level) still produces a legal separated pattern when demand-driven days leave no consecutive pair free", () => {
    const e = makeAce("e1", ["Boarding"]);
    const demandDriven: Record<string, { employeeId: string; dayOfWeek: string; shiftCode: string; coversRoles: string[] }[]> = {};
    for (const d of DAYS) demandDriven[d] = [];
    for (const d of ["Monday", "Wednesday", "Friday", "Sunday"]) demandDriven[d] = [{ employeeId: "e1", dayOfWeek: d, shiftCode: "NR01", coversRoles: ["Boarding"] }];
    const preferred = new Map([["e1", new Set(["Tuesday", "Wednesday"]) as ReadonlySet<string>]]);
    const added = generateObligationToppedUpShifts(DAYS, [e], demandDriven, CONFIG, new Map(), CONFIG.minimum_rest_hours, PRE_REGIME_WEEK, undefined, preferred);
    const worked = new Set([...["Monday", "Wednesday", "Friday", "Sunday"], ...DAYS.filter((d) => added[d].length > 0)]);
    expect(worked.size).toBe(5);
  });
});

describe("zero impact on fixed-cycle and other non-flexible populations", () => {
  it("every non-flexible employee's roster is byte-identical with the OFF/OFF bias on or off (seed data)", () => {
    const on = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, "W", CURRENT_WEEK_START);
    const off = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, "W", CURRENT_WEEK_START, new Map(), "unknown", { offWindowStructureBias: false });
    const nonFlexibleIds = new Set(EMPLOYEES.filter((e) => !isFlexibleGeneralPool(e)).map((e) => e.id));
    const pick = (p: typeof on) => p.rosterEntries.filter((r) => nonFlexibleIds.has(r.employee_id));
    expect(pick(on)).toEqual(pick(off));
    expect(pick(on).length).toBeGreaterThan(0);

    // Fixed-cycle teams (Transit/Leaders/Duty Officers) still come straight
    // from their static weekly_shifts cycle — never given an OFF window.
    const fixedCycle = EMPLOYEES.filter((e) => usesFixedCycleRotation(e.assignment));
    expect(fixedCycle.length).toBeGreaterThan(0);
    for (const e of fixedCycle) {
      for (const ws of e.weekly_shifts) {
        const entry = on.rosterEntries.find((r) => r.employee_id === e.id && r.day_of_week === ws.day_of_week)!;
        expect(entry.status).toBe(ws.status);
      }
    }
  });
});
