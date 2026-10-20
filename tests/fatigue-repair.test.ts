import { describe, it, expect } from "vitest";
import { repairRosterFatigue, FatigueRepairInput, FatigueRepairEmployeeInput } from "../lib/planning/fatigue-repair";
import { PROTOTYPE_FATIGUE_CONFIG, DEFAULT_FATIGUE_CONFIG } from "../lib/fatigue-config";
import { accumulateFatigueOverDays, neutralFatigueState, ShiftOnDate } from "../lib/planning/fatigue-model";
import { HardWorkCaps } from "../lib/planning/hard-work-caps";
import { DAYS_ORDER, flightDateFor } from "../lib/flight-date";

// Post-regime (>= 2026-09-20) catalog, 2026-10-19 is a real Monday.
// Every scenario below was found by actually running repairRosterFatigue
// (never hand-derived burden numbers) and is re-verified independently
// here via combinedBurdenFor / accumulateFatigueOverDays, so these tests
// exercise the real fatigue model's real numbers, not invented ones.
const WEEK_START = "2026-10-19";
const DAYS5 = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

const GENEROUS_CAPS: HardWorkCaps = { maxConsecutiveWorkDays: 10, maxContinuousShiftHours: null, maxConsecutiveNightShifts: null };

function baseInput(overrides: Partial<FatigueRepairInput> = {}): FatigueRepairInput {
  return {
    daysOrder: DAYS5,
    weekStart: WEEK_START,
    minimumRestHours: 15,
    caps: GENEROUS_CAPS,
    employees: [],
    fatigueConfig: PROTOTYPE_FATIGUE_CONFIG,
    ...overrides,
  };
}

/** Independently computes the same combined-burden objective fatigue-repair.ts itself uses, so a test can assert on it without re-trusting the module under test. */
function combinedBurdenFor(daysOrder: string[], weekStart: string, patA: (string | null)[], patB: (string | null)[]): number {
  const toShifts = (pattern: (string | null)[]): (ShiftOnDate | null)[] =>
    pattern.map((code, i) => (code ? { code, date: flightDateFor(weekStart, daysOrder[i]) } : null));
  const a = accumulateFatigueOverDays(neutralFatigueState("unknown_start"), toShifts(patA), PROTOTYPE_FATIGUE_CONFIG);
  const b = accumulateFatigueOverDays(neutralFatigueState("unknown_start"), toShifts(patB), PROTOTYPE_FATIGUE_CONFIG);
  return a.accumulatedBurden + b.accumulatedBurden;
}

// A legal, improving, same-code (AP01) two-day swap: E_A's Monday AP01 and
// E_B's Wednesday AP01 trade places. Confirmed (see "sanity" test below)
// to strictly lower combined burden, and to be the ONLY move
// repairRosterFatigue finds for this pair under generous caps.
function apSwapScenario(): FatigueRepairEmployeeInput[] {
  return [
    { employeeId: "E_A", pattern: ["AP01", "MT03", null, "AP01", null] },
    { employeeId: "E_B", pattern: [null, null, null, "MT03", "AP01"] },
  ];
}
const AP_SWAP_AFTER_A: (string | null)[] = [null, "MT03", null, "AP01", "AP01"];
const AP_SWAP_AFTER_B: (string | null)[] = ["AP01", null, null, "MT03", null];

// A legal, improving, same-code (NT01) swap -- used to exercise the
// night-shift-cap and shift-duration-cap gates, since the AP01/MT03
// scenario above never involves a night shift.
function nightSwapScenario(): FatigueRepairEmployeeInput[] {
  return [
    { employeeId: "E_A", pattern: [null, "NT01", "AP01", "AP01", null] },
    { employeeId: "E_B", pattern: ["MT03", null, null, null, "NT01"] },
  ];
}

// A legal, improving, same-code (MT03) swap whose NEWLY-WORKED day for
// E_A is day index 0 (Monday) -- the only day position where
// priorWeekBoundaryContext is ever consulted -- used to exercise the
// cross-week rest-legality gate.
function boundarySwapScenario(): FatigueRepairEmployeeInput[] {
  return [
    { employeeId: "E_A", pattern: [null, null, "MT03", "AP01", "AP01"] },
    { employeeId: "E_B", pattern: ["MT03", null, null, null, null] },
  ];
}

describe("lib/planning/fatigue-repair — bounded, deterministic roster-level fatigue repair (LABOR RULES v2, 2026-10-20)", () => {
  it("sanity: the AP01-swap scenario really is worse than its swapped form under PROTOTYPE_FATIGUE_CONFIG", () => {
    const [a, b] = apSwapScenario();
    const before = combinedBurdenFor(DAYS5, WEEK_START, a.pattern, b.pattern);
    const after = combinedBurdenFor(DAYS5, WEEK_START, AP_SWAP_AFTER_A, AP_SWAP_AFTER_B);
    expect(after).toBeLessThan(before);
  });

  it("is a no-op when fatigueConfig is omitted (defaults to the globally-disabled config)", () => {
    const employees = apSwapScenario();
    const input = baseInput({ employees, fatigueConfig: undefined });
    const result = repairRosterFatigue(input);
    expect(result.moves).toEqual([]);
    expect(result.attemptsUsed).toBe(0);
    expect(result.budgetExhausted).toBe(false);
    expect(result.patterns.get("E_A")).toEqual(employees[0].pattern);
    expect(result.patterns.get("E_B")).toEqual(employees[1].pattern);
  });

  it("is a no-op when fatigueConfig is explicitly disabled, even with an improving swap available", () => {
    const employees = apSwapScenario();
    const input = baseInput({ employees, fatigueConfig: { ...PROTOTYPE_FATIGUE_CONFIG, enabled: false } });
    const result = repairRosterFatigue(input);
    expect(result.moves).toEqual([]);
    expect(result.patterns.get("E_A")).toEqual(employees[0].pattern);
  });

  it("is a no-op under DEFAULT_FATIGUE_CONFIG (the real global default)", () => {
    const input = baseInput({ employees: apSwapScenario(), fatigueConfig: DEFAULT_FATIGUE_CONFIG });
    const result = repairRosterFatigue(input);
    expect(result.moves).toEqual([]);
  });

  it("finds and applies the single improving, legal, coverage/hours-preserving swap", () => {
    const employees = apSwapScenario();
    const savedA = [...employees[0].pattern];
    const savedB = [...employees[1].pattern];
    const result = repairRosterFatigue(baseInput({ employees }));

    expect(result.moves).toHaveLength(1);
    const move = result.moves[0];
    expect(move.employeeAId).toBe("E_A");
    expect(move.employeeBId).toBe("E_B");
    expect(move.dayIndexA).toBe(0); // Monday: where E_A was working AP01
    expect(move.dayIndexB).toBe(4); // Friday: where E_B was working AP01
    expect(move.code).toBe("AP01");
    expect(move.combinedBurdenAfter).toBeLessThan(move.combinedBurdenBefore);

    expect(result.patterns.get("E_A")).toEqual(AP_SWAP_AFTER_A);
    expect(result.patterns.get("E_B")).toEqual(AP_SWAP_AFTER_B);

    const expectedBefore = combinedBurdenFor(DAYS5, WEEK_START, savedA, savedB);
    const expectedAfter = combinedBurdenFor(DAYS5, WEEK_START, AP_SWAP_AFTER_A, AP_SWAP_AFTER_B);
    expect(move.combinedBurdenBefore).toBeCloseTo(expectedBefore, 9);
    expect(move.combinedBurdenAfter).toBeCloseTo(expectedAfter, 9);

    expect(result.attemptsUsed).toBeGreaterThan(0);
    expect(result.budgetExhausted).toBe(false);

    // Never mutates the caller's own pattern arrays.
    expect(employees[0].pattern).toEqual(savedA);
    expect(employees[1].pattern).toEqual(savedB);
  });

  it("preserves each employee's own total codes (coverage and hours untouched -- only WHICH day moved)", () => {
    const employees = apSwapScenario();
    const result = repairRosterFatigue(baseInput({ employees }));
    const sortedCodes = (p: (string | null)[]) => [...p].sort();
    expect(sortedCodes(result.patterns.get("E_A")!)).toEqual(sortedCodes(employees[0].pattern));
    expect(sortedCodes(result.patterns.get("E_B")!)).toEqual(sortedCodes(employees[1].pattern));
  });

  it("never applies a swap across two different shift codes (no candidate exists)", () => {
    const employees: FatigueRepairEmployeeInput[] = [
      { employeeId: "E_A", pattern: [null, "MT03", null, "MT03", null] },
      { employeeId: "E_B", pattern: [null, null, null, "MT03", "AP01"] },
    ];
    const savedA = [...employees[0].pattern];
    const savedB = [...employees[1].pattern];
    const result = repairRosterFatigue(baseInput({ employees }));
    expect(result.moves).toEqual([]);
    expect(result.patterns.get("E_A")).toEqual(savedA);
    expect(result.patterns.get("E_B")).toEqual(savedB);
  });

  it("rejects an otherwise-improving swap that would break 15h rest against the real prior week", () => {
    const employees = boundarySwapScenario();
    const savedA = [...employees[0].pattern];
    const savedB = [...employees[1].pattern];
    // Baseline: confirm this scenario DOES find a move without the boundary.
    const baseline = repairRosterFatigue(baseInput({ employees: boundarySwapScenario() }));
    expect(baseline.moves).toHaveLength(1);

    // With a real prior-week shift for E_A ending just before its new
    // Monday MT03 (05:45 start), there is nowhere near 15h of rest.
    const input = baseInput({
      employees,
      priorWeekBoundaryContext: new Map([["E_A", { shift_start: "08:00", shift_end: "23:00" }]]),
    });
    const result = repairRosterFatigue(input);
    expect(result.moves).toEqual([]);
    expect(result.patterns.get("E_A")).toEqual(savedA);
    expect(result.patterns.get("E_B")).toEqual(savedB);
  });

  it("rejects an otherwise-improving swap that would exceed a configured max consecutive night shifts of 0", () => {
    const employees = nightSwapScenario();
    const savedA = [...employees[0].pattern];
    // Baseline: confirm this scenario DOES find a move under generous caps.
    const baseline = repairRosterFatigue(baseInput({ employees: nightSwapScenario() }));
    expect(baseline.moves).toHaveLength(1);
    expect(baseline.moves[0].code).toBe("NT01");

    const result = repairRosterFatigue(baseInput({ employees, caps: { ...GENEROUS_CAPS, maxConsecutiveNightShifts: 0 } }));
    expect(result.moves).toEqual([]);
    expect(result.patterns.get("E_A")).toEqual(savedA);
  });

  it("rejects an otherwise-improving swap that would exceed a configured max continuous shift duration below NT01's own span", () => {
    const employees = nightSwapScenario();
    const result = repairRosterFatigue(baseInput({ employees, caps: { ...GENEROUS_CAPS, maxContinuousShiftHours: 10 } })); // NT01 is ~12.75h
    expect(result.moves).toEqual([]);
  });

  it("rejects every candidate swap that would split an already-complete consecutive OFF block (weekly OFF-day hard rules)", () => {
    const daysOrder = DAYS_ORDER; // full 7-day week -- breaksOffDayRules only applies at this length
    const employees: FatigueRepairEmployeeInput[] = [
      // Mon,Tue work; Wed,Thu OFF (a complete consecutive block); Fri,Sat,Sun work.
      { employeeId: "E_A", pattern: ["MT03", "MT03", null, null, "MT03", "MT03", "MT03"] },
      // Monday and Sunday OFF (cyclically adjacent -- also a complete block).
      { employeeId: "E_B", pattern: [null, "MT03", "MT03", "MT03", "MT03", "MT03", null] },
    ];
    const savedA = [...employees[0].pattern];
    const savedB = [...employees[1].pattern];
    const input = baseInput({
      daysOrder,
      employees,
      offDayRules: { minimumOffDays: 2, consecutive: true },
    });
    const result = repairRosterFatigue(input);
    expect(result.moves).toEqual([]);
    expect(result.patterns.get("E_A")).toEqual(savedA);
    expect(result.patterns.get("E_B")).toEqual(savedB);
    // Confirms the search actually tried candidates and rejected every one,
    // rather than finding none at all.
    expect(result.attemptsUsed).toBeGreaterThan(0);
  });

  it("stops immediately when the attempt budget is exhausted before any candidate is evaluated", () => {
    const employees = apSwapScenario();
    const result = repairRosterFatigue(baseInput({ employees, attemptBudget: 0 }));
    expect(result.moves).toEqual([]);
    expect(result.attemptsUsed).toBe(0);
    expect(result.budgetExhausted).toBe(true);
  });

  it("is deterministic: the same input always produces the same moves and final patterns", () => {
    const run = () => repairRosterFatigue(baseInput({ employees: apSwapScenario() }));
    const r1 = run();
    const r2 = run();
    expect(r1.moves).toEqual(r2.moves);
    expect([...r1.patterns.entries()]).toEqual([...r2.patterns.entries()]);
    expect(r1.attemptsUsed).toBe(r2.attemptsUsed);
  });

  it("reaches a fixed point and does not oscillate: re-running on the already-repaired patterns finds no further move", () => {
    const first = repairRosterFatigue(baseInput({ employees: apSwapScenario() }));
    const employees2: FatigueRepairEmployeeInput[] = [
      { employeeId: "E_A", pattern: first.patterns.get("E_A")! },
      { employeeId: "E_B", pattern: first.patterns.get("E_B")! },
    ];
    const second = repairRosterFatigue(baseInput({ employees: employees2 }));
    expect(second.moves).toEqual([]);
  });
});
