import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { generateFlexiblePoolShifts, PriorDayShiftMap } from "../lib/planning/shift-generation";
import { generateDraftWeeklyPlan } from "../lib/planning/generate-draft-plan";
import { generateObligationToppedUpShifts } from "../lib/planning/roster-generation";
import { generateForeignCompanyShifts } from "../lib/planning/specialized-team-generation";
import { aggregateDailyDemand, DailyDemand } from "../lib/planning/demand-aggregation";
import { computeWeeklyStaffingRequirements } from "../lib/planning/weekly-requirements";
import { Stage6OffWindowContext } from "../lib/planning/off-window";
import {
  stage6CandidateScore,
  fatigueScoreSteps,
  HARD_COVERAGE_UNIT,
  T1_DEMAND_BIAS_WEIGHT,
  OFF_WINDOW_STRUCTURE_CONFLICT_WEIGHT,
  OFF_WINDOW_STRUCTURE_MAX_TOTAL,
  MAX_OFF_WINDOW_STRUCTURE_CONFLICTS,
  FATIGUE_TIER_BUDGET,
  FATIGUE_SCORE_STEP,
  FATIGUE_SCORE_MAX_TOTAL,
  MAX_FATIGUE_SCORE_STEPS,
  FATIGUE_BURDEN_PER_STEP,
  STAGE6_BUCKETS_PER_DAY,
} from "../lib/planning/stage6-score-tiers";
import {
  createFatigueLedger,
  advanceFatigueLedger,
  stage6FatigueContextFromLedger,
  Stage6FatigueContext,
  CandidateFatigueInput,
} from "../lib/planning/fatigue-planning";
import {
  accumulateFatigueOverDays,
  computeShiftBurden,
  neutralFatigueState,
  FatigueState,
  FatigueStateOrUnknown,
} from "../lib/planning/fatigue-model";
import { deriveIncomingFatigueState, IncomingFatigueSeed } from "../lib/planning/fatigue-continuity";
import { DEFAULT_FATIGUE_CONFIG, PROTOTYPE_FATIGUE_CONFIG, FATIGUE_MODEL_ENABLED } from "../lib/fatigue-config";
import { scoreCandidates } from "../lib/scoring";
import { flightDateFor } from "../lib/flight-date";
import { getShiftTimesAs } from "../lib/shift-templates";
import { isFlexibleGeneralPool } from "../lib/planning/workforce-pools";
import { CONFIGURED_COMPANIES, getCompanyRequiredAgents } from "../lib/company-config";
import { EMPLOYEES, FLIGHTS, CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_START } from "../lib/seed-data";
import { Employee, Flight } from "../lib/types";

/**
 * Fatigue-aware roster planning milestone, PART 2 (2026-09-24): the
 * fatigue model built in part 1 is WIRED into the planner's real decision
 * points — Stage 6 (tier 4 of stage6-score-tiers.ts), the Stage-6.5
 * top-up, the foreign-company roster distribution, and scoreCandidates'
 * new, separate `fatigueWeight` dimension — gated behind an explicitly-
 * passed ENABLED config. FATIGUE_MODEL_ENABLED stays false.
 *
 * Requirement map (see the milestone brief):
 *   (a) lower-fatigue legal candidate preferred when operationally equivalent
 *   (b) coverage is never sacrificed to chase lower fatigue (formula + integration)
 *   (c) foreign-company headcount remains covered regardless of fatigue
 *   (d) fatigue distributes difficult company commitments among eligible members
 *   (e) date-aware GMT shift definitions feed fatigue inside the real pipeline
 *   (f) default (disabled) behaviour is byte-identical to before this phase
 */

const C = PROTOTYPE_FATIGUE_CONFIG; // synthetic prototype weights, switched ON explicitly for tests
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const POST_WEEK = "2026-09-21"; // Monday, GMT regime
const WEDNESDAY_POST = "2026-09-23";
const DIGIT = /\d/;

function makeAce(id: string, skills: string[]): Employee {
  return {
    id, name: id, skills, assignment: "General T1 Pool",
    shift_code: null, shift_start: null, shift_end: null, rest_before_shift_hours: 24, weekly_hours: 0,
    is_duty_officer: false, off_days: [], foreign_company_authorizations: [], active: true,
    weekly_shifts: DAYS.map((d) => ({ day_of_week: d, shift_code: null, status: "off" as const })),
  };
}

/** A DailyDemand needing `count` of `role` in every 30-min bucket of [from, to). */
function demandFor(day: string, role: string, from: string, to: string, count = 1): DailyDemand {
  const toMin = (t: string) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
  const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return {
    dayOfWeek: day,
    buckets: Array.from({ length: 48 }, (_, i) => ({
      start: fmt(i * 30),
      end: fmt((i + 1) * 30 === 1440 ? 0 : (i + 1) * 30),
      demandByRole: i * 30 >= toMin(from) && i * 30 < toMin(to) ? { [role]: count } : {},
    })),
  };
}

/** A Stage-6 fatigue context from explicit incoming states (no last-worked shift). */
function ctx(states: [string, FatigueStateOrUnknown][]): Stage6FatigueContext {
  return { config: C, statesEnteringDay: new Map(states) };
}

/** Three consecutive very-early MT02 days ending the day before WEDNESDAY_POST — a materially heavier recent pattern. */
const HEAVY: FatigueState = accumulateFatigueOverDays(neutralFatigueState("prior_plan"), [
  { code: "MT02", date: "2026-09-20" },
  { code: "MT02", date: "2026-09-21" },
  { code: "MT02", date: "2026-09-22" },
], C);
/** A light recent pattern: one daytime shift, then two OFF days. */
const LIGHT: FatigueState = accumulateFatigueOverDays(neutralFatigueState("prior_plan"), [{ code: "NR01", date: "2026-09-20" }, null, null], C);

function stage6(day: string, date: string, demand: DailyDemand, employees: Employee[], fatigue?: Stage6FatigueContext, prior: PriorDayShiftMap = new Map(), offWindow?: Stage6OffWindowContext) {
  return generateFlexiblePoolShifts(day, date, demand, employees, prior, 15, undefined, new Map(), new Map(), undefined, offWindow, fatigue);
}

// ---------------------------------------------------------------------------
// (b) formula-level invariants
// ---------------------------------------------------------------------------

describe("(b) tier 4 — the fatigue term can never outrank hard coverage, T1 refinement or OFF/OFF structure (formula invariants)", () => {
  it("the maximum possible fatigue contribution is strictly smaller than the smallest non-zero Tier-3 difference (one structural conflict)", () => {
    expect(FATIGUE_SCORE_MAX_TOTAL).toBe(MAX_FATIGUE_SCORE_STEPS * FATIGUE_SCORE_STEP);
    expect(FATIGUE_SCORE_MAX_TOTAL).toBeLessThan(FATIGUE_TIER_BUDGET);
    expect(FATIGUE_TIER_BUDGET).toBeLessThan(OFF_WINDOW_STRUCTURE_CONFLICT_WEIGHT);
    // Tiers 3+4 together stay below one T1 bucket, so a covering candidate always scores > 0.
    expect(OFF_WINDOW_STRUCTURE_MAX_TOTAL + FATIGUE_SCORE_MAX_TOTAL).toBeLessThan(T1_DEMAND_BIAS_WEIGHT);
  });

  it("one fewer structural conflict ALWAYS wins, even with the maximum fatigue penalty against the better-structured candidate", () => {
    for (const [hard, t1] of [[0, 1], [1, 0], [3, 7], [47, 48]]) {
      for (let conflicts = 0; conflicts < MAX_OFF_WINDOW_STRUCTURE_CONFLICTS; conflicts++) {
        expect(stage6CandidateScore(hard, t1, conflicts, MAX_FATIGUE_SCORE_STEPS)).toBeGreaterThan(stage6CandidateScore(hard, t1, conflicts + 1, 0));
      }
    }
  });

  it("one more hard unit / one more T1 bucket ALWAYS wins over any fatigue advantage (worst case for the better-covering candidate)", () => {
    for (let hard = 0; hard < STAGE6_BUCKETS_PER_DAY; hard++) {
      for (const t1 of [0, 1, 24, STAGE6_BUCKETS_PER_DAY]) {
        expect(stage6CandidateScore(hard + 1, 0, MAX_OFF_WINDOW_STRUCTURE_CONFLICTS, MAX_FATIGUE_SCORE_STEPS)).toBeGreaterThan(stage6CandidateScore(hard, t1, 0, 0));
      }
    }
    for (let t1 = 0; t1 < STAGE6_BUCKETS_PER_DAY; t1++) {
      if (t1 === 0) continue;
      expect(stage6CandidateScore(2, t1 + 1, MAX_OFF_WINDOW_STRUCTURE_CONFLICTS, MAX_FATIGUE_SCORE_STEPS)).toBeGreaterThan(stage6CandidateScore(2, t1, 0, 0));
    }
  });

  it("fatigue can never turn a covering candidate into a non-candidate, nor a non-covering one into a candidate", () => {
    expect(stage6CandidateScore(0, 1, MAX_OFF_WINDOW_STRUCTURE_CONFLICTS, MAX_FATIGUE_SCORE_STEPS)).toBeGreaterThan(0);
    expect(stage6CandidateScore(0, 0, 0, MAX_FATIGUE_SCORE_STEPS)).toBe(0);
    // Clamped: a bogus step count cannot exceed the bounded tier; NaN is inert.
    expect(stage6CandidateScore(1, 0, 0, 1e12)).toBe(stage6CandidateScore(1, 0, 0, MAX_FATIGUE_SCORE_STEPS));
    expect(stage6CandidateScore(1, 0, 0, Number.NaN)).toBe(stage6CandidateScore(1, 0, 0));
    expect(stage6CandidateScore(1, 0, 0, -5)).toBe(stage6CandidateScore(1, 0, 0));
  });

  it("among tier-1..3-equal candidates, lower resulting burden wins; steps quantize monotonically and saturate below the budget", () => {
    expect(fatigueScoreSteps(0)).toBe(0);
    expect(fatigueScoreSteps(-3)).toBe(0);
    expect(fatigueScoreSteps(Number.POSITIVE_INFINITY)).toBe(0);
    expect(fatigueScoreSteps(1.23)).toBe(Math.round(1.23 / FATIGUE_BURDEN_PER_STEP));
    expect(fatigueScoreSteps(1e6)).toBe(MAX_FATIGUE_SCORE_STEPS);
    let previous = -1;
    for (let b = 0; b <= 120; b += 0.37) {
      const s = fatigueScoreSteps(b);
      expect(s).toBeGreaterThanOrEqual(previous);
      previous = s;
    }
    expect(stage6CandidateScore(3, 7, 1, fatigueScoreSteps(2.0))).toBeGreaterThan(stage6CandidateScore(3, 7, 1, fatigueScoreSteps(2.5)));
  });

  it("with fatigueSteps omitted or 0 the score is BIT-identical to the tiers 1-3 formula (default behaviour cannot drift)", () => {
    for (let hard = 0; hard <= 48; hard += 3) {
      for (const t1 of [0, 1, 5, 48]) {
        for (let c = 0; c <= MAX_OFF_WINDOW_STRUCTURE_CONFLICTS; c++) {
          const tiers123 = hard * HARD_COVERAGE_UNIT + t1 * T1_DEMAND_BIAS_WEIGHT === 0 ? 0 : hard * HARD_COVERAGE_UNIT + t1 * T1_DEMAND_BIAS_WEIGHT - c * OFF_WINDOW_STRUCTURE_CONFLICT_WEIGHT;
          expect(Object.is(stage6CandidateScore(hard, t1, c), tiers123)).toBe(true);
          expect(Object.is(stage6CandidateScore(hard, t1, c, 0), tiers123)).toBe(true);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (a) lower-fatigue legal candidate preferred when operationally equivalent
// ---------------------------------------------------------------------------

describe("(a) Stage 6 prefers the lower-fatigue legal candidate when operationally equivalent", () => {
  // Gate 06:00-14:30 on a post-regime Wednesday: MT01/MT03/MT02/JR01/JR02
  // all cover every bucket (same hard coverage, no T1, no OFF window).
  const demand = demandFor("Wednesday", "Gate", "06:00", "14:30");
  const heavy = makeAce("a-heavy", ["Gate"]); // id sorts FIRST: the final id tie-break would pick it
  const light = makeAce("b-light", ["Gate"]);

  it("sanity: without fatigue (or with the default disabled config) the plain tie-break picks a-heavy", () => {
    expect(stage6(`Wednesday`, WEDNESDAY_POST, demand, [heavy, light]).map((g) => g.employeeId)).toEqual(["a-heavy"]);
    const disabled = stage6("Wednesday", WEDNESDAY_POST, demand, [heavy, light], { config: DEFAULT_FATIGUE_CONFIG, statesEnteringDay: new Map([[heavy.id, HEAVY], [light.id, LIGHT]]) });
    expect(disabled).toEqual(stage6("Wednesday", WEDNESDAY_POST, demand, [heavy, light]));
    expect(disabled[0]).not.toHaveProperty("fatigueReason");
  });

  it("with fatigue enabled the employee with materially lower accumulated burden is chosen (Agent B over Agent A), with a digit-free reason", () => {
    expect(HEAVY.accumulatedBurden).toBeGreaterThan(LIGHT.accumulatedBurden + 5);
    const result = stage6("Wednesday", WEDNESDAY_POST, demand, [heavy, light], ctx([[heavy.id, HEAVY], [light.id, LIGHT]]));
    expect(result.map((g) => g.employeeId)).toEqual(["b-light"]);
    expect(result[0].coversRoles).toEqual(["Gate"]);
    expect(result[0].fatigueReason).toBeDefined();
    expect(result[0].fatigueReason!.length).toBeGreaterThan(0);
    expect(result[0].fatigueReason).toContain("Lower recent early-shift burden");
    for (const label of result[0].fatigueReason!) expect(label).not.toMatch(DIGIT);
  });

  it("uses ACCUMULATED state, not just today's single-shift burden: identical codes, only the history differs", () => {
    // Both candidates' best code is the same (MT03, the lowest single-shift
    // burden here) — the choice can only come from the incoming state.
    const result = stage6("Wednesday", WEDNESDAY_POST, demand, [heavy, light], ctx([[heavy.id, HEAVY], [light.id, LIGHT]]));
    expect(result[0].shiftCode).toBe("MT03");
    const swapped = stage6("Wednesday", WEDNESDAY_POST, demand, [heavy, light], ctx([[heavy.id, LIGHT], [light.id, HEAVY]]));
    expect(swapped.map((g) => g.employeeId)).toEqual(["a-heavy"]);
  });

  it("for ONE employee, prefers the less burdensome legal CODE among equally-covering codes (NR01 over MT03, equal duration)", () => {
    // Gate 12:00-14:30, post regime: MT03 (05:45-14:45) and NR01 (08:00-17:00) both cover it with 9h — tied on
    // tiers 1-3 AND on the duration tie-break; catalog order alone picks MT03.
    const d = demandFor("Wednesday", "Gate", "12:00", "14:30");
    const solo = makeAce("solo", ["Gate"]);
    expect(stage6("Wednesday", WEDNESDAY_POST, d, [solo])[0].shiftCode).toBe("MT03");
    const withFatigue = stage6("Wednesday", WEDNESDAY_POST, d, [solo], ctx([[solo.id, LIGHT]]));
    expect(withFatigue[0].shiftCode).toBe("NR01");
    expect(computeShiftBurden("NR01", WEDNESDAY_POST, C)).toBeLessThan(computeShiftBurden("MT03", WEDNESDAY_POST, C));
    expect(withFatigue[0].fatigueReason).toContain("Lower recent early-shift burden");
  });

  it("an employee with no incoming state is an explicit unknown (neutral), never penalized as if heavily loaded", () => {
    const result = stage6("Wednesday", WEDNESDAY_POST, demand, [heavy, light], ctx([[heavy.id, HEAVY]]));
    expect(result.map((g) => g.employeeId)).toEqual(["b-light"]);
  });
});

// ---------------------------------------------------------------------------
// (b) integration: coverage is never sacrificed to chase lower fatigue
// ---------------------------------------------------------------------------

describe("(b) Stage 6 integration — coverage and legality always beat fatigue", () => {
  // Gate 04:00-05:00 post regime: only the 03:45-start codes (MT02/JR02) cover it.
  const early = demandFor("Wednesday", "Gate", "04:00", "05:00");
  const heavy = makeAce("z-heavy", ["Gate"]);
  const states = ctx([[heavy.id, HEAVY], ["a-light", LIGHT], ["a-light-illegal", LIGHT]]);

  it("the ONLY qualified employee is rostered even though a lower-fatigue (unqualified) employee exists — no gap", () => {
    const unqualified = makeAce("a-light", ["Check-in"]);
    const result = stage6("Wednesday", WEDNESDAY_POST, early, [unqualified, heavy], states);
    expect(result.map((g) => g.employeeId)).toEqual(["z-heavy"]);
    expect(["MT02", "JR02"]).toContain(result[0].shiftCode);
  });

  it("15h rest stays HARD: the lower-fatigue employee is not rest-legal for the only covering codes, so the heavier one covers", () => {
    const lightButIllegal = makeAce("a-light-illegal", ["Gate"]);
    // Worked NR02 (08:00-18:15) yesterday: 18:15 -> 03:45 = 9.5h < 15h.
    const prior: PriorDayShiftMap = new Map([[lightButIllegal.id, { shift_start: "08:00", shift_end: "18:15" }]]);
    const result = stage6("Wednesday", WEDNESDAY_POST, early, [lightButIllegal, heavy], states, prior);
    expect(result.map((g) => g.employeeId)).toEqual(["z-heavy"]);
  });

  it("a candidate covering MORE hard demand wins however much heavier its fatigue", () => {
    // Two simultaneous Gate units -> both must be rostered.
    const two = demandFor("Wednesday", "Gate", "04:00", "05:00", 2);
    const light = makeAce("a-light", ["Gate"]);
    const result = stage6("Wednesday", WEDNESDAY_POST, two, [light, heavy], states);
    expect(result.map((g) => g.employeeId).sort()).toEqual(["a-light", "z-heavy"]);
    // Sequential Gate + Boarding: the multi-skilled heavy employee covers both roles on one shift and is chosen first.
    const mixed = demandFor("Wednesday", "Gate", "06:00", "08:00");
    for (let i = 20; i < 24; i++) mixed.buckets[i].demandByRole = { Boarding: 1 };
    const multi = makeAce("z-heavy-multi", ["Gate", "Boarding"]);
    const gateOnly = makeAce("a-light", ["Gate"]);
    const r2 = stage6("Wednesday", WEDNESDAY_POST, mixed, [gateOnly, multi], ctx([[multi.id, HEAVY], [gateOnly.id, LIGHT]]));
    expect(r2.find((g) => g.employeeId === multi.id)?.coversRoles.sort()).toEqual(["Boarding", "Gate"]);
  });

  it("OFF/OFF structure (tier 3) beats fatigue (tier 4): the light employee's preferred OFF day keeps them off", () => {
    const d = demandFor("Wednesday", "Gate", "06:00", "14:30");
    const light = makeAce("a-light", ["Gate"]);
    const offWindow: Stage6OffWindowContext = {
      preferredOffDaysByEmployee: new Map([[light.id, new Set(["Wednesday", "Thursday"])], [heavy.id, new Set(["Saturday", "Sunday"])]]),
    };
    const result = stage6("Wednesday", WEDNESDAY_POST, d, [light, heavy], states, new Map(), offWindow);
    expect(result.map((g) => g.employeeId)).toEqual(["z-heavy"]);
  });

  it("seed-data pipeline with fatigue enabled: every flexible-pool hard (bucket, role) unit Stage 6 covers with fatigue off is still covered — no new unfilled duty, no rest violation", () => {
    for (const weekStart of [CURRENT_WEEK_START, POST_WEEK]) {
      const off = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, "W", weekStart);
      const on = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, "W", weekStart, new Map(), "unknown", { fatigue: { config: C } });
      const count = (p: typeof on, type: string) => p.issues.filter((i) => i.type === type).length;
      expect(count(on, "unfilled_duty")).toBeLessThanOrEqual(count(off, "unfilled_duty"));
      expect(count(on, "rest_violation")).toBe(0);
      expect(on.restViolationsPrevented).toHaveLength(0);
      // Fatigue actually participated (not a silent no-op) and explained itself without raw numbers.
      const withReason = Object.values(on.generatedShiftsByDay).flat().filter((g) => g.fatigueReason !== undefined);
      expect(withReason.length).toBeGreaterThan(0);
      for (const g of withReason) for (const label of g.fatigueReason!) expect(label).not.toMatch(DIGIT);
    }
  });
});

// ---------------------------------------------------------------------------
// (c) + (d) foreign-company commitments
// ---------------------------------------------------------------------------

function makeQatar(id: string): Employee {
  return {
    id, name: id, skills: ["Boarding"], assignment: "Qatar Airways",
    shift_code: null, shift_start: null, shift_end: null, rest_before_shift_hours: null,
    weekly_hours: null, is_duty_officer: false, off_days: [], foreign_company_authorizations: ["Qatar Airways"],
    active: true, weekly_shifts: [],
  };
}

function qatarFlight(id: string, day: string, departure = "09:00"): Flight {
  return {
    id, flight_number: "QR105", airline: "Qatar Airways", route: "CMN → DOH",
    origin: "CMN", destination: "DOH", aircraft: "Airbus A320", equipment_code: null,
    registration: null, callsign: null, terminal: "T1", scheduled_departure: departure,
    scheduled_arrival: "18:00", gate: null, boarding_window_start: null, boarding_window_end: null,
    status: "scheduled", booking_pressure: "normal", day_of_week: day, flight_date: flightDateFor(POST_WEEK, day),
    week_start: POST_WEEK, operator_type: "self_managed", destination_category: null,
    booked_passengers: null, seat_capacity: null,
  };
}

const QATAR_HEADCOUNT = getCompanyRequiredAgents("Qatar Airways")!;

describe("(d) fatigue distributes a difficult foreign-company commitment among equally-eligible team members", () => {
  // 09:00 departure -> protected window 04:30-09:00 -> a very early MT02 (03:45) commitment.
  const pool = [makeQatar("q-0-heavy"), makeQatar("q-1-light"), makeQatar("q-2-light")];
  const flights = [qatarFlight("qr-wed", "Wednesday")];
  const incoming = new Map<string, FatigueStateOrUnknown>([["q-0-heavy", HEAVY], ["q-1-light", LIGHT], ["q-2-light", LIGHT]]);

  it(`sanity: QATAR headcount is ${QATAR_HEADCOUNT} and without fatigue the first team members in pool order take it`, () => {
    expect(QATAR_HEADCOUNT).toBe(2);
    const off = generateForeignCompanyShifts(DAYS, pool, flights, ["Qatar Airways"], 15, POST_WEEK);
    expect(off.generatedShiftsByDay.Wednesday.map((g) => g.employeeId)).toEqual(["q-0-heavy", "q-1-light"]);
    expect(off.generatedShiftsByDay.Wednesday.every((g) => g.shiftCode === "MT02")).toBe(true);
  });

  it("with fatigue enabled the materially-heavier member is spared the difficult early commitment; the lower-burden members take it", () => {
    const on = generateForeignCompanyShifts(DAYS, pool, flights, ["Qatar Airways"], 15, POST_WEEK, new Map(), undefined, { config: C, incomingStates: incoming });
    const wed = on.generatedShiftsByDay.Wednesday;
    expect(wed.map((g) => g.employeeId).sort()).toEqual(["q-1-light", "q-2-light"]);
    expect(on.conflicts).toEqual([]);
    for (const g of wed) {
      expect(g.coversRoles).toEqual(["Qatar Airways"]);
      for (const label of g.fatigueReason!) expect(label).not.toMatch(DIGIT);
    }
    // q-2 is the member fatigue brought in (displacing q-0): explained. q-1 would have been picked anyway: [].
    expect(wed.find((g) => g.employeeId === "q-2-light")!.fatigueReason).toContain("Lower recent early-shift burden");
    expect(wed.find((g) => g.employeeId === "q-1-light")!.fatigueReason).toEqual([]);
  });

  it("Stage 9 / Find-Agent: scoreCandidates' fatigueWeight ranks the lower-burden authorized member first for the same commitment", () => {
    const rostered = (id: string): Employee => ({ ...makeQatar(id), shift_code: "MT02", shift_start: "03:45", shift_end: "15:00", rest_before_shift_hours: 24, weekly_hours: 20 });
    const candidates = [rostered("q-0-heavy"), rostered("q-1-light")];
    const window = { start: "04:30", end: "09:00" };
    const fatigue: CandidateFatigueInput = { config: C, statesByEmployee: incoming };
    const off = scoreCandidates("Company Team", window, candidates, CONFIG, {}, "Qatar Airways", new Map(), fatigue);
    expect(off.map((r) => r.employee.id)).toEqual(["q-0-heavy", "q-1-light"]); // fatigueWeight 0 -> input order, no reason key
    expect(off[0]).not.toHaveProperty("fatigueReason");
    const cfg = { ...CONFIG, fairness_weights: { ...CONFIG.fairness_weights, fatigueWeight: 1 } };
    const on = scoreCandidates("Company Team", window, candidates, cfg, {}, "Qatar Airways", new Map(), fatigue);
    expect(on.map((r) => r.employee.id)).toEqual(["q-1-light", "q-0-heavy"]);
    expect(on[0].fatigueReason).toContain("Lower recent early-shift burden");
  });
});

describe("(c) foreign-company headcount remains covered regardless of fatigue", () => {
  it("when the fatigue-preferred member is not rest-legal for the commitment, the others cover it — zero shortfall, and the same coverage as with fatigue off", () => {
    const pool = [makeQatar("q-0-heavy"), makeQatar("q-1-heavy"), makeQatar("q-2-light")];
    // Mon/Wed/Fri flights (alternate days, so MT02's 12.75h daily rest never binds between flight days).
    const flights = ["Monday", "Wednesday", "Friday"].map((d) => qatarFlight(`qr-${d}`, d));
    const incoming = new Map<string, FatigueStateOrUnknown>([["q-0-heavy", HEAVY], ["q-1-heavy", HEAVY], ["q-2-light", LIGHT]]);
    // q-2 (lowest burden — fatigue's first choice) worked AP03 until 01:15 on the prior Sunday: MT02 at 03:45 Monday is illegal.
    const boundary: PriorDayShiftMap = new Map([["q-2-light", { shift_start: "17:45", shift_end: "01:15" }]]);

    const off = generateForeignCompanyShifts(DAYS, pool, flights, ["Qatar Airways"], 15, POST_WEEK, boundary, CONFIG);
    const on = generateForeignCompanyShifts(DAYS, pool, flights, ["Qatar Airways"], 15, POST_WEEK, boundary, CONFIG, { config: C, incomingStates: incoming });

    expect(on.conflicts).toEqual([]);
    expect(off.conflicts).toEqual([]);
    for (const day of ["Monday", "Wednesday", "Friday"]) {
      const company = (r: typeof on) => r.generatedShiftsByDay[day].filter((g) => g.coversRoles.includes("Qatar Airways"));
      expect(company(on)).toHaveLength(QATAR_HEADCOUNT);
      expect(company(off)).toHaveLength(QATAR_HEADCOUNT);
    }
    const monday = on.generatedShiftsByDay.Monday.filter((g) => g.coversRoles.includes("Qatar Airways")).map((g) => g.employeeId).sort();
    expect(monday).toEqual(["q-0-heavy", "q-1-heavy"]); // coverage won over fatigue's preference
    // Fatigue still steers later days toward the rested light member.
    expect(on.generatedShiftsByDay.Wednesday.some((g) => g.employeeId === "q-2-light" && g.coversRoles.includes("Qatar Airways"))).toBe(true);
  });

  it("scoreCandidates: fatigue is ranking-only — it never bypasses a hard exclusion or lifts a flagged candidate", () => {
    const rostered = (id: string, extra: Partial<Employee> = {}): Employee => ({ ...makeQatar(id), shift_code: "MT02", shift_start: "03:45", shift_end: "15:00", rest_before_shift_hours: 24, weekly_hours: 20, ...extra });
    const cfg = { ...CONFIG, fairness_weights: { ...CONFIG.fairness_weights, fatigueWeight: 1 } };
    const window = { start: "04:30", end: "09:00" };
    const fatigue: CandidateFatigueInput = { config: C, statesByEmployee: new Map([["q-heavy", HEAVY], ["q-light", LIGHT], ["q-light-flagged", LIGHT]]) };
    // q-light has an overlapping protected commitment -> hard-excluded, fatigue cannot bring it back.
    const excluded = scoreCandidates("Company Team", window, [rostered("q-heavy"), rostered("q-light")], cfg, { "q-light": [{ start: "05:00", end: "06:00" }] }, "Qatar Airways", new Map(), fatigue);
    expect(excluded.map((r) => r.employee.id)).toEqual(["q-heavy"]);
    // A flagged (under-rested) light candidate never moves ahead of a recommended heavy one.
    const flagged = scoreCandidates("Company Team", window, [rostered("q-light-flagged", { rest_before_shift_hours: 8 }), rostered("q-heavy")], cfg, {}, "Qatar Airways", new Map(), fatigue);
    expect(flagged.map((r) => [r.employee.id, r.status])).toEqual([["q-heavy", "recommended"], ["q-light-flagged", "flagged"]]);
    expect(flagged[1]).not.toHaveProperty("fatigueReason");
  });

  it("seed-data pipeline with fatigue enabled: foreign-company coverage conflicts are identical to fatigue off", () => {
    const off = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, "W", POST_WEEK);
    const on = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, "W", POST_WEEK, new Map(), "unknown", { fatigue: { config: C } });
    const demandConflicts = (p: typeof on) => p.configurationIssues.filter((i) => i.requirementId.startsWith("specialized-demand-conflict-")).map((i) => i.requirementId).sort();
    expect(demandConflicts(on)).toEqual(demandConflicts(off));
    for (const company of CONFIGURED_COMPANIES) {
      const headcount = getCompanyRequiredAgents(company)!;
      for (const day of DAYS_WITH_DATA) {
        const needed = FLIGHTS.some((f) => f.airline === company && f.day_of_week === day);
        if (!needed || demandConflicts(off).some((id) => id.includes(`-${company}-${day}`))) continue;
        expect(on.generatedShiftsByDay[day].filter((g) => g.coversRoles.includes(company)).length).toBe(headcount);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// scoreCandidates: fatigue and workload hours are SEPARATE dimensions
// ---------------------------------------------------------------------------

describe("scoreCandidates — workload hours (4a) and fatigue burden (4b) stay separate, in a fixed order", () => {
  const rostered = (id: string): Employee => ({ ...makeAce(id, ["Boarding"]), shift_code: "NR01", shift_start: "08:00", shift_end: "17:00", rest_before_shift_hours: 24, weekly_hours: 10 });
  const window = { start: "09:00", end: "10:00" };
  const fatigue: CandidateFatigueInput = { config: C, statesByEmployee: new Map([["x-heavy", HEAVY], ["y-light", LIGHT]]) };
  const candidates = [rostered("x-heavy"), rostered("y-light")];
  const weights = (workloadHoursWeight: number, fatigueWeight: number) => ({ ...CONFIG, fairness_weights: { workloadHoursWeight, fatigueWeight } });

  it("fatigue alone reorders only when fatigueWeight > 0 AND the input is enabled", () => {
    expect(scoreCandidates("Boarding", window, candidates, weights(0, 1), {}, undefined, new Map(), fatigue).map((r) => r.employee.id)).toEqual(["y-light", "x-heavy"]);
    expect(scoreCandidates("Boarding", window, candidates, weights(0, 1), {}, undefined, new Map(), { ...fatigue, config: DEFAULT_FATIGUE_CONFIG }).map((r) => r.employee.id)).toEqual(["x-heavy", "y-light"]);
    expect(scoreCandidates("Boarding", window, candidates, weights(0, 0), {}, undefined, new Map(), fatigue).map((r) => r.employee.id)).toEqual(["x-heavy", "y-light"]);
    // A persisted config_snapshot from before the field existed (no fatigueWeight key) is a no-op too.
    expect(scoreCandidates("Boarding", window, candidates, { ...CONFIG, fairness_weights: { workloadHoursWeight: 0 } }, {}, undefined, new Map(), fatigue).map((r) => r.employee.id)).toEqual(["x-heavy", "y-light"]);
  });

  it("with both on, workload hours is the first key: fatigue only breaks ties hours leave (never combined into one number)", () => {
    const heavyHasFewerHours = new Map([["x-heavy", 10], ["y-light", 30]]);
    expect(scoreCandidates("Boarding", window, candidates, weights(1, 1), {}, undefined, heavyHasFewerHours, fatigue).map((r) => r.employee.id)).toEqual(["x-heavy", "y-light"]);
    const equalHours = new Map([["x-heavy", 20], ["y-light", 20]]);
    expect(scoreCandidates("Boarding", window, candidates, weights(1, 1), {}, undefined, equalHours, fatigue).map((r) => r.employee.id)).toEqual(["y-light", "x-heavy"]);
    // Relative magnitude does not change the order of the keys.
    expect(scoreCandidates("Boarding", window, candidates, weights(1, 1000), {}, undefined, heavyHasFewerHours, fatigue).map((r) => r.employee.id)).toEqual(["x-heavy", "y-light"]);
  });
});

// ---------------------------------------------------------------------------
// Stage-6.5 top-up
// ---------------------------------------------------------------------------

describe("Stage-6.5 top-up prefers the lower-burden legal code, below its existing preferences", () => {
  it("post regime: shortest-first would pick MT03 (9h, early start); with fatigue the equally-short, lower-burden NR01 is chosen", () => {
    const e = makeAce("e1", ["Boarding"]);
    const demandDriven: Record<string, { employeeId: string; dayOfWeek: string; shiftCode: string; coversRoles: string[] }[]> = {};
    for (const d of DAYS) demandDriven[d] = [];
    for (const d of ["Monday", "Tuesday", "Wednesday"]) demandDriven[d] = [{ employeeId: "e1", dayOfWeek: d, shiftCode: "NR01", coversRoles: ["Boarding"] }];

    const off = generateObligationToppedUpShifts(DAYS, [e], demandDriven, CONFIG, new Map(), CONFIG.minimum_rest_hours, POST_WEEK);
    const on = generateObligationToppedUpShifts(DAYS, [e], demandDriven, CONFIG, new Map(), CONFIG.minimum_rest_hours, POST_WEEK, undefined, undefined, C);
    const added = (r: typeof on) => DAYS.flatMap((d) => r[d].map((g) => `${d}:${g.shiftCode}`));
    expect(added(off).length).toBe(2);
    expect(added(on).length).toBe(2); // same number of days (5 WORK + 2 OFF) — fatigue never changes WHETHER a day is filled
    expect(added(off).every((s) => s.endsWith(":MT03"))).toBe(true);
    expect(added(on).every((s) => s.endsWith(":NR01"))).toBe(true);
    const onAdded = DAYS.flatMap((d) => on[d]);
    for (const g of onAdded) for (const label of g.fatigueReason!) expect(label).not.toMatch(DIGIT);
    // The first added day is where fatigue displaced MT03 outright (later days are explained against the final
    // week, where MT03 is no longer rest-legal after an NR01, so fatigue did not change them: []).
    expect(onAdded[0].fatigueReason).toContain("Lower recent early-shift burden");
    for (const d of DAYS) for (const g of off[d]) expect(g).not.toHaveProperty("fatigueReason");
  });
});

// ---------------------------------------------------------------------------
// (e) date-aware GMT shift definitions inside the real pipeline
// ---------------------------------------------------------------------------

describe("(e) the fatigue wiring resolves each real date across the 2026-09-20 regime boundary", () => {
  const WEEK = "2026-09-14"; // Mon 14 .. Sun 20 — Saturday is GMT+1, Sunday is GMT
  const SAT = flightDateFor(WEEK, "Saturday");
  const SUN = flightDateFor(WEEK, "Sunday");

  it("sanity: the week straddles the boundary", () => {
    expect([SAT, SUN]).toEqual(["2026-09-19", "2026-09-20"]);
    expect(getShiftTimesAs("MT01", SAT)).not.toEqual(getShiftTimesAs("MT01", SUN));
  });

  it("the burden ranking of MT01 vs MT03 flips across the boundary, and the fatigue-driven Stage-6 pick flips with it — through a real day-by-day FatigueLedger", () => {
    // Real times: Sat MT01 05:45-14:45 (9h) vs MT03 05:45-15:45 (10h); Sun MT01 05:45-15:00 vs MT03 05:45-14:45.
    expect(computeShiftBurden("MT01", SAT, C)).toBeLessThan(computeShiftBurden("MT03", SAT, C));
    expect(computeShiftBurden("MT03", SUN, C)).toBeLessThan(computeShiftBurden("MT01", SUN, C));

    const e = makeAce("e1", ["Gate"]);
    const ledger = createFatigueLedger([e.id], C, new Map([[e.id, neutralFatigueState("prior_plan")]]));
    const gate = (day: string) => demandFor(day, "Gate", "06:00", "14:30");

    const sat = stage6("Saturday", SAT, gate("Saturday"), [e], stage6FatigueContextFromLedger(ledger));
    expect(sat.map((g) => g.shiftCode)).toEqual(["MT01"]);
    advanceFatigueLedger(ledger, SAT, new Map(sat.map((g) => [g.employeeId, g.shiftCode])));

    const priorForSunday: PriorDayShiftMap = new Map([[e.id, getShiftTimesAs("MT01", SAT)]]);
    const sun = stage6("Sunday", SUN, gate("Sunday"), [e], stage6FatigueContextFromLedger(ledger), priorForSunday);
    expect(sun.map((g) => g.shiftCode)).toEqual(["MT03"]);
    advanceFatigueLedger(ledger, SUN, new Map(sun.map((g) => [g.employeeId, g.shiftCode])));

    // The ledger's running state is exactly the model folded over the REAL codes on their REAL dates
    // (incl. the cross-boundary transition), not a single catalog applied to both days.
    const expected = accumulateFatigueOverDays(neutralFatigueState("prior_plan"), [{ code: "MT01", date: SAT }, { code: "MT03", date: SUN }], C);
    const actual = ledger.states.get(e.id) as FatigueState;
    expect(actual.accumulatedBurden).toBeCloseTo(expected.accumulatedBurden, 12);
    const wrongCatalog = accumulateFatigueOverDays(neutralFatigueState("prior_plan"), [{ code: "MT01", date: SUN }, { code: "MT03", date: SUN }], C);
    expect(actual.accumulatedBurden).not.toBeCloseTo(wrongCatalog.accumulatedBurden, 6);
  });

  it("fatigue (not the duration tie-break) decides, and uses each side's real sortie: Gate 16:00-17:00 -> Sat NR02 (NR01 ends 16:45, AP01 is shorter but burdens a late finish), Sun NR01 (ends 17:00)", () => {
    const e = makeAce("e1", ["Gate"]);
    const gate = (day: string) => demandFor(day, "Gate", "16:00", "17:00");
    const state = ctx([[e.id, neutralFatigueState("prior_plan")]]);
    // Without fatigue the shortest covering code wins on Saturday.
    expect(stage6("Saturday", SAT, gate("Saturday"), [e])[0].shiftCode).toBe("AP01");
    expect(stage6("Saturday", SAT, gate("Saturday"), [e], state)[0].shiftCode).toBe("NR02");
    expect(computeShiftBurden("NR02", SAT, C)).toBeLessThan(computeShiftBurden("AP01", SAT, C));
    expect(stage6("Sunday", SUN, gate("Sunday"), [e], state)[0].shiftCode).toBe("NR01");
  });

  it("the FULL pipeline (generateDraftWeeklyPlan, fatigue enabled, real incoming seeds) resolves each day's real regime: NR02 displaces AP01 on GMT+1 days, NR01 appears only on the GMT Sunday", () => {
    // 17:00 departures every day -> Gate/Boarding demand through 17:00. GMT+1: NR01 ends 16:45 (cannot cover), NR02 and
    // AP01 can — AP01 is shorter, NR02 is lower-burden (no late finish). GMT (Sunday 2026-09-20): NR01 ends 17:00.
    const aces = ["p-0", "p-1", "p-2"].map((id) => makeAce(id, ["Boarding", "Gate"]));
    const flights: Flight[] = DAYS.map((d, i) => ({
      id: `f-${d}`, flight_number: `AT${100 + i}`, airline: "Royal Air Maroc", route: "CMN → X", origin: "CMN", destination: "X",
      aircraft: "Boeing 737-800", equipment_code: null, registration: null, callsign: null, terminal: "T1", scheduled_departure: "17:00",
      scheduled_arrival: null, gate: null, boarding_window_start: null, boarding_window_end: null, status: "scheduled", booking_pressure: "normal",
      day_of_week: d, flight_date: flightDateFor(WEEK, d), week_start: WEEK, operator_type: "atlas_managed", destination_category: "Europe/Schengen",
      booked_passengers: null, seat_capacity: null,
    }));
    // Explicit "unknown" seeds (no predecessor data) — the honest first-week case.
    const seeds = new Map<string, IncomingFatigueSeed>(aces.map((a) => [a.id, deriveIncomingFatigueState(a, { kind: "none" }, C)]));
    const on = generateDraftWeeklyPlan(flights, aces, [], CONFIG, DAYS, "W", WEEK, new Map(), "unknown", { fatigue: { config: C, incomingSeeds: seeds } });
    const off = generateDraftWeeklyPlan(flights, aces, [], CONFIG, DAYS, "W", WEEK);
    const count = (p: typeof on, type: string) => p.issues.filter((i) => i.type === type).length;
    expect(count(on, "unfilled_duty")).toBeLessThanOrEqual(count(off, "unfilled_duty"));
    expect(count(on, "rest_violation")).toBe(0);

    const covering = (p: typeof on, day: string) => p.generatedShiftsByDay[day].filter((g) => g.coversRoles.length > 0);
    const preDays = DAYS.slice(0, 6);
    // Without fatigue, GMT+1 days only ever use the shorter AP01; with fatigue, NR02 (lower burden on those real times) appears.
    expect(preDays.flatMap((d) => covering(off, d)).some((g) => g.shiftCode === "NR02")).toBe(false);
    const nr02 = preDays.flatMap((d) => covering(on, d)).filter((g) => g.shiftCode === "NR02");
    expect(nr02.length).toBeGreaterThan(0);
    for (const g of nr02) {
      const date = flightDateFor(WEEK, g.dayOfWeek);
      expect(computeShiftBurden("NR02", date, C)).toBeLessThan(computeShiftBurden("AP01", date, C));
      expect(g.fatigueReason!.length).toBeGreaterThan(0);
      for (const label of g.fatigueReason!) expect(label).not.toMatch(DIGIT);
    }
    // NR01 cannot cover on any GMT+1 day (real 16:45 sortie), but is used on the GMT Sunday (real 17:00 sortie).
    expect(preDays.flatMap((d) => covering(on, d)).some((g) => g.shiftCode === "NR01")).toBe(false);
    expect(covering(on, "Sunday").some((g) => g.shiftCode === "NR01")).toBe(true);
    for (const day of DAYS) for (const g of on.generatedShiftsByDay[day]) expect(g.fatigueReason).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// (f) default behaviour is byte-identical to before this phase
// ---------------------------------------------------------------------------

/**
 * sha256 fingerprints (first 16 hex chars) of each function's JSON output
 * on seed data, captured by running this exact fingerprint procedure
 * against commit 37f70c4 — the last commit BEFORE part 2 wired fatigue in.
 * Any drift in default behaviour anywhere in Stage 6, the top-up, the
 * foreign roster, scoreCandidates or the full pipeline changes a hash.
 */
const PRE_WIRING_FINGERPRINTS: Record<string, string> = {
  "plan:2026-08-31": "d2277084b9c8a568",
  "stage6:2026-08-31": "765613e53f0d2c61",
  "topup:2026-08-31": "796fa5d0f3bc9033",
  "foreign:2026-08-31": "44f17c92cb58a252",
  "plan:2026-09-21": "6774cc598245b782",
  "stage6:2026-09-21": "35e4ca6007983334",
  "topup:2026-09-21": "14206ef5e76dbc39",
  "foreign:2026-09-21": "f1f168a3dcc70052",
  "score:Boarding:0": "a37c5bb9e85fdb75",
  "score:Qatar:0": "88eedf7072a15efc",
  "score:Boarding:1": "37bb3c051860cb4d",
  "score:Qatar:1": "742c59c261d79b2f",
};

type FingerprintMode = "omitted" | "disabled-config";

function fingerprints(mode: FingerprintMode): Record<string, string> {
  const h = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
  const disabled = mode === "disabled-config";
  const out: Record<string, string> = {};
  for (const ws of [CURRENT_WEEK_START, POST_WEEK]) {
    const { generatedAt, ...rest } = disabled
      ? generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, "W", ws, new Map(), "unknown", { fatigue: { config: DEFAULT_FATIGUE_CONFIG } })
      : generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, "W", ws);
    void generatedAt;
    out[`plan:${ws}`] = h(rest);
    const reqs = computeWeeklyStaffingRequirements(FLIGHTS, CONFIG);
    const day = DAYS_WITH_DATA[0];
    const demand = aggregateDailyDemand(day, FLIGHTS, reqs, CONFIG.checkin_demand_policy);
    const disabledStage6: Stage6FatigueContext = {
      config: DEFAULT_FATIGUE_CONFIG,
      statesEnteringDay: new Map(EMPLOYEES.filter(isFlexibleGeneralPool).map((e, i) => [e.id, i % 2 ? HEAVY : LIGHT])),
    };
    out[`stage6:${ws}`] = h(
      disabled
        ? generateFlexiblePoolShifts(day, ws, demand, EMPLOYEES, new Map(), CONFIG.minimum_rest_hours, undefined, new Map(), new Map(), undefined, undefined, disabledStage6)
        : generateFlexiblePoolShifts(day, ws, demand, EMPLOYEES, new Map(), CONFIG.minimum_rest_hours)
    );
    const demandDriven: Record<string, { employeeId: string; dayOfWeek: string; shiftCode: string; coversRoles: string[] }[]> = {};
    for (const d of DAYS_WITH_DATA) demandDriven[d] = [];
    const flex = EMPLOYEES.filter((e) => e.assignment === "General T1 Pool").slice(0, 6);
    flex.forEach((e, i) => {
      const d = DAYS_WITH_DATA[i % DAYS_WITH_DATA.length];
      demandDriven[d].push({ employeeId: e.id, dayOfWeek: d, shiftCode: "NR01", coversRoles: ["Boarding"] });
    });
    out[`topup:${ws}`] = h(
      disabled
        ? generateObligationToppedUpShifts(DAYS_WITH_DATA, EMPLOYEES, demandDriven, CONFIG, new Map(), CONFIG.minimum_rest_hours, ws, undefined, undefined, DEFAULT_FATIGUE_CONFIG)
        : generateObligationToppedUpShifts(DAYS_WITH_DATA, EMPLOYEES, demandDriven, CONFIG, new Map(), CONFIG.minimum_rest_hours, ws)
    );
    out[`foreign:${ws}`] = h(
      disabled
        ? generateForeignCompanyShifts(DAYS_WITH_DATA, EMPLOYEES, FLIGHTS, CONFIGURED_COMPANIES, CONFIG.minimum_rest_hours, ws, new Map(), CONFIG, { config: DEFAULT_FATIGUE_CONFIG })
        : generateForeignCompanyShifts(DAYS_WITH_DATA, EMPLOYEES, FLIGHTS, CONFIGURED_COMPANIES, CONFIG.minimum_rest_hours, ws, new Map(), CONFIG)
    );
  }
  const hours = new Map(EMPLOYEES.map((e, i) => [e.id, (i * 7) % 40]));
  // Disabled mode: an ENABLED fatigue input but fatigueWeight 0 — the weight gate alone must keep it a no-op.
  const enabledInput: CandidateFatigueInput = { config: C, statesByEmployee: new Map(EMPLOYEES.map((e, i) => [e.id, i % 3 ? HEAVY : LIGHT])) };
  for (const w of [0, 1]) {
    const cfg = { ...CONFIG, fairness_weights: { ...CONFIG.fairness_weights, workloadHoursWeight: w } };
    const score = (role: string, window: { start: string; end: string }, auth?: string) =>
      disabled ? scoreCandidates(role, window, EMPLOYEES, cfg, {}, auth, hours, enabledInput) : scoreCandidates(role, window, EMPLOYEES, cfg, {}, auth, hours);
    out[`score:Boarding:${w}`] = h(score("Boarding", { start: "06:00", end: "07:00" }));
    out[`score:Qatar:${w}`] = h(score("Company Team", { start: "09:00", end: "13:00" }, "Qatar Airways"));
  }
  return out;
}

describe("(f) regression — at the default, Stage 6, the top-up, the foreign roster, scoreCandidates and the full pipeline are byte-identical to before this phase", () => {
  it("the global default stays OFF", () => {
    expect(FATIGUE_MODEL_ENABLED).toBe(false);
    expect(DEFAULT_FATIGUE_CONFIG.enabled).toBe(false);
    expect(CONFIG.fairness_weights.fatigueWeight ?? 0).toBe(0);
  });

  it("no fatigue argument passed: every fingerprint equals the pre-wiring commit's", () => {
    expect(fingerprints("omitted")).toEqual(PRE_WIRING_FINGERPRINTS);
  });

  it("fatigue arguments passed but disabled (DEFAULT_FATIGUE_CONFIG / fatigueWeight 0): still every fingerprint equals the pre-wiring commit's", () => {
    expect(fingerprints("disabled-config")).toEqual(PRE_WIRING_FINGERPRINTS);
  });

  it("the fingerprints are non-trivial (the scored pools and plans are non-empty)", () => {
    const cfg = { ...CONFIG };
    expect(scoreCandidates("Boarding", { start: "06:00", end: "07:00" }, EMPLOYEES, cfg).length).toBeGreaterThan(0);
    expect(scoreCandidates("Company Team", { start: "09:00", end: "13:00" }, EMPLOYEES, cfg, {}, "Qatar Airways").length).toBeGreaterThan(0);
  });
});
