import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  computeShiftBurden,
  computeShiftBurdenBreakdown,
  computeTransitionBurden,
  computeDayBurdenBreakdown,
  maxTransitionBurden,
  accumulateFatigue,
  accumulateFatigueOverDays,
  explainFatigueFactors,
  lookupTransportContext,
  neutralFatigueState,
  unknownFatigueState,
  FatigueState,
  ShiftOnDate,
} from "../lib/planning/fatigue-model";
import {
  DEFAULT_FATIGUE_CONFIG,
  PROTOTYPE_FATIGUE_CONFIG,
  PROTOTYPE_FATIGUE_WEIGHTS,
  FATIGUE_MODEL_ENABLED,
  FatigueConfig,
} from "../lib/fatigue-config";
import { getShiftTimesAs, getShiftDurationHours, resolveShiftRegime } from "../lib/shift-templates";
import { restHoursBetween } from "../lib/roster-generation";

const C = PROTOTYPE_FATIGUE_CONFIG;
const PRE = "2026-09-03"; // before the 2026-09-20 GMT+1 -> GMT regime change
const POST = "2026-09-22"; // after it

function toMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/** Consecutive real dates starting at `start` (YYYY-MM-DD, UTC arithmetic). */
function datesFrom(start: string, count: number): string[] {
  const d = new Date(`${start}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => {
    const x = new Date(d);
    x.setUTCDate(d.getUTCDate() + i);
    return x.toISOString().slice(0, 10);
  });
}

function withWeights(overrides: Partial<FatigueConfig["weights"]>): FatigueConfig {
  return { ...C, weights: { ...C.weights, ...overrides } };
}

describe("fatigue-config — neutral by default, centralized, individually zeroable", () => {
  it("the model is OFF by default: every fatigue function is a true no-op under DEFAULT_FATIGUE_CONFIG", () => {
    expect(FATIGUE_MODEL_ENABLED).toBe(false);
    expect(DEFAULT_FATIGUE_CONFIG.enabled).toBe(false);
    expect(computeShiftBurden("MT02", PRE)).toBe(0);
    expect(computeShiftBurden("NT01", POST)).toBe(0);
    expect(computeTransitionBurden({ code: "AP02", date: PRE }, { code: "MT02", date: "2026-09-05" })).toBe(0);
    const s = accumulateFatigue(null, 5, false, 0.4);
    expect(s.accumulatedBurden).toBe(0);
    expect(explainFatigueFactors(s)).toEqual([]);
  });

  it("transport burden defaults to 0 even in the enabled prototype config", () => {
    expect(PROTOTYPE_FATIGUE_WEIGHTS.transportBurdenWeight).toBe(0);
    expect(PROTOTYPE_FATIGUE_CONFIG.weights.transportBurdenWeight).toBe(0);
  });

  it("zeroing one weight removes exactly that component and nothing else", () => {
    const full = computeShiftBurdenBreakdown("MT02", PRE, C);
    const noEarly = computeShiftBurdenBreakdown("MT02", PRE, withWeights({ earlyStartWeight: 0 }));
    expect(noEarly.earlyStartComponent).toBe(0);
    expect(noEarly.nightComponent).toBe(full.nightComponent);
    expect(noEarly.durationComponent).toBe(full.durationComponent);
    expect(noEarly.dayBurden).toBeCloseTo(full.dayBurden - full.earlyStartComponent, 10);
  });
});

describe("computeShiftBurden — real date-resolved times, both regimes", () => {
  for (const date of [PRE, POST]) {
    it(`(${resolveShiftRegime(date)}) an early/circadian-unfriendly code (MT02) carries materially more burden than a daytime code (NR01)`, () => {
      // Read the real times through the resolver — never hardcoded here.
      const mt02 = getShiftTimesAs("MT02", date);
      const nr01 = getShiftTimesAs("NR01", date);
      expect(toMin(mt02.shift_start)).toBeLessThan(toMin(nr01.shift_start)); // premise: MT02 really is the earlier start on this date

      const mt02Burden = computeShiftBurden("MT02", date, C);
      const nr01Burden = computeShiftBurden("NR01", date, C);
      expect(mt02Burden).toBeGreaterThan(nr01Burden * 2);

      const b = computeShiftBurdenBreakdown("MT02", date, C);
      expect(b.earlyStartComponent).toBeGreaterThan(0);
      expect(b.isEarlyStart).toBe(true);
      expect(computeShiftBurdenBreakdown("NR01", date, C).earlyStartComponent).toBe(0);
    });

    it(`(${resolveShiftRegime(date)}) the duration term uses the real date-resolved duration, including overnight codes crossing midnight`, () => {
      for (const code of ["MT02", "NR01", "NT01", "AP03", "N8"]) {
        const b = computeShiftBurdenBreakdown(code, date, C);
        const expected = C.weights.durationWeight * (getShiftDurationHours(code, date) / C.thresholds.referenceDurationHours);
        expect(b.durationComponent).toBeCloseTo(expected, 10);
        expect(b.durationComponent).toBeGreaterThan(0);
      }
      // An overnight code's night-window work is measured across midnight.
      expect(computeShiftBurdenBreakdown("NT01", date, C).nightComponent).toBeGreaterThan(0);
      expect(computeShiftBurdenBreakdown("NT01", date, C).isNightWork).toBe(true);
    });
  }

  it("burden tracks the ACTUAL regime times: where a code's real start moves earlier across 2026-09-20, its early-start burden rises accordingly", () => {
    for (const code of ["MT02", "JR02", "MT01", "NR01"]) {
      const startPre = toMin(getShiftTimesAs(code, PRE).shift_start);
      const startPost = toMin(getShiftTimesAs(code, POST).shift_start);
      const earlyPre = computeShiftBurdenBreakdown(code, PRE, C).earlyStartComponent;
      const earlyPost = computeShiftBurdenBreakdown(code, POST, C).earlyStartComponent;
      if (startPost < startPre && startPre < toMin(C.thresholds.earlyStartBefore)) expect(earlyPost).toBeGreaterThan(earlyPre);
      if (startPost === startPre) expect(earlyPost).toBe(earlyPre);
    }
  });
});

describe("computeTransitionBurden — bounded soft cost, never a rest-legality verdict", () => {
  it("same time-of-day on consecutive days costs nothing; a large legal swing costs more", () => {
    const same = computeTransitionBurden({ code: "NR01", date: "2026-09-01" }, { code: "NR01", date: "2026-09-02" }, C);
    expect(same).toBe(0);
    // MT01 -> AP01 next day is 15h+ rest (legal) but an 8h swing.
    const mt01 = getShiftTimesAs("MT01", "2026-09-01");
    const ap01 = getShiftTimesAs("AP01", "2026-09-02");
    expect(restHoursBetween(mt01.shift_start, mt01.shift_end, ap01.shift_start)).toBeGreaterThanOrEqual(15);
    const swing = computeTransitionBurden({ code: "MT01", date: "2026-09-01" }, { code: "AP01", date: "2026-09-02" }, C);
    expect(swing).toBeGreaterThan(same);
  });

  it("a late shift followed (legally, across an OFF day) by a very early one costs more than the forward direction of a similar swing, and less than if it were adjacent", () => {
    const lateToEarly = computeTransitionBurden({ code: "AP02", date: "2026-09-01" }, { code: "MT02", date: "2026-09-03" }, C);
    const earlyToLate = computeTransitionBurden({ code: "MT02", date: "2026-09-01" }, { code: "AP02", date: "2026-09-03" }, C);
    expect(lateToEarly).toBeGreaterThan(earlyToLate);
    expect(lateToEarly).toBeGreaterThan(0);
    // Same pair with no OFF day in between is (hypothetically) weighted more — the damping is real.
    const adjacentHypothetical = computeTransitionBurden({ code: "AP02", date: "2026-09-01" }, { code: "MT02", date: "2026-09-02" }, C);
    expect(adjacentHypothetical).toBeGreaterThan(lateToEarly);
  });

  it("is bounded, returns a plain number (never a verdict), and 0 with no previous shift", () => {
    const codes = ["MT02", "MT01", "NR01", "AP01", "AP02", "AP03", "NT01", "JR01", "N8"];
    for (const a of codes) for (const b of codes) {
      const v = computeTransitionBurden({ code: a, date: POST }, { code: b, date: "2026-09-23" }, C);
      expect(typeof v).toBe("number");
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(maxTransitionBurden(C) + 1e-12);
    }
    expect(computeTransitionBurden(null, { code: "MT02", date: POST }, C)).toBe(0);
  });
});

describe("accumulateFatigue — compounding and recovery", () => {
  const week = datesFrom("2026-09-07", 7);
  const run = (codes: (string | null)[]): FatigueState =>
    accumulateFatigueOverDays(neutralFatigueState("prior_plan"), codes.map((c, i): ShiftOnDate | null => (c ? { code: c, date: week[i] } : null)), C);

  it("five consecutive very-early starts (MT02) are NOT scored like five daytime shifts (NR01): they compound beyond their own summed day burdens", () => {
    const early = run(["MT02", "MT02", "MT02", "MT02", "MT02"]);
    const day = run(["NR01", "NR01", "NR01", "NR01", "NR01"]);
    const earlySum = [0, 1, 2, 3, 4].reduce((s, i) => s + computeShiftBurden("MT02", week[i], C), 0);
    const daySum = [0, 1, 2, 3, 4].reduce((s, i) => s + computeShiftBurden("NR01", week[i], C), 0);

    expect(early.accumulatedBurden).toBeGreaterThan(earlySum); // compounding, not plain addition
    expect(day.accumulatedBurden).toBeCloseTo(daySum, 10); // normal days never compound
    // And the ratio exceeds the plain per-shift burden ratio.
    expect(early.accumulatedBurden / day.accumulatedBurden).toBeGreaterThan(earlySum / daySum);
    expect(early.consecutiveDifficultDays).toBe(5);
    expect(early.consecutiveVeryEarlyDays).toBe(5);
    expect(early.lastDay!.consecutiveDifficultComponent).toBeGreaterThan(0);
  });

  it("the SAME total day burden compounds more when difficult days are consecutive than when spread across normal days", () => {
    const hard = 3.5;
    const norm = 1.0;
    let grouped: FatigueState | null = null;
    for (const b of [hard, hard, hard, norm, norm]) grouped = accumulateFatigue(grouped, b, false, 0.4, C);
    let spread: FatigueState | null = null;
    for (const b of [hard, norm, hard, norm, hard]) spread = accumulateFatigue(spread, b, false, 0.4, C);
    expect(grouped!.accumulatedBurden).toBeGreaterThan(spread!.accumulatedBurden);
    expect(spread!.accumulatedBurden).toBeCloseTo(3 * hard + 2 * norm, 10); // no run -> no compounding
  });

  it("two consecutive OFF days recover measurably more than one, the second more than the first, and no single OFF day erases accumulated burden", () => {
    const loaded = run(["MT02", "MT02", "MT02", "MT02", "MT02"]);
    const oneOff = accumulateFatigue(loaded, 0, true, C.weights.recoveryWeight, C);
    const twoOff = accumulateFatigue(oneOff, 0, true, C.weights.recoveryWeight, C);
    expect(oneOff.accumulatedBurden).toBeLessThan(loaded.accumulatedBurden);
    expect(twoOff.accumulatedBurden).toBeLessThan(oneOff.accumulatedBurden);
    const firstFraction = oneOff.lastDay!.recoveryCredit / loaded.accumulatedBurden;
    const secondFraction = twoOff.lastDay!.recoveryCredit / oneOff.accumulatedBurden;
    expect(secondFraction).toBeGreaterThan(firstFraction); // consecutive OFF bonus
    expect(twoOff.consecutiveOffDays).toBe(2);

    // Even an absurd recoveryWeight cannot wipe the slate in one day.
    const oneHugeDay = accumulateFatigue(loaded, 0, true, 1.0, C);
    expect(oneHugeDay.accumulatedBurden).toBeGreaterThanOrEqual(loaded.accumulatedBurden * (1 - C.thresholds.maxSingleDayRecoveryFraction) - 1e-12);
    expect(oneHugeDay.accumulatedBurden).toBeGreaterThan(0);

    // Consecutive OFF/OFF beats the same two OFF days split by a work day.
    const split = accumulateFatigue(
      accumulateFatigue(oneOff, computeShiftBurden("NR01", week[5], C), false, C.weights.recoveryWeight, C),
      0, true, C.weights.recoveryWeight, C
    );
    expect(twoOff.accumulatedBurden).toBeLessThan(split.accumulatedBurden);
  });

  it("an unknown / null prior state starts from a neutral zero tagged unknown_start — never an invented history", () => {
    const fromUnknown = accumulateFatigue(unknownFatigueState("first-ever week"), 1.5, false, 0.4, C);
    expect(fromUnknown.provenance).toBe("unknown_start");
    expect(fromUnknown.daysObserved).toBe(1);
    expect(fromUnknown.accumulatedBurden).toBeCloseTo(1.5, 10);
    expect(accumulateFatigue(null, 1.5, false, 0.4, C).provenance).toBe("unknown_start");
  });
});

describe("explainFatigueFactors — short neutral labels, never raw numbers", () => {
  const week = datesFrom("2026-09-07", 7);
  const run = (codes: (string | null)[]) =>
    accumulateFatigueOverDays(neutralFatigueState("prior_plan"), codes.map((c, i): ShiftOnDate | null => (c ? { code: c, date: week[i] } : null)), C);
  const BANNED = /fatigued|unsafe|exhausted|tired|danger|risk|medical/i;

  it("prefers the candidate with lower recent early-shift burden and names the avoided third consecutive very-early shift", () => {
    const heavyEarly = run(["NR01", "NR01", "MT02", "MT02"]);
    const daytime = run(["NR01", "NR01", "NR01", "NR01"]);
    const candidateShift = computeDayBurdenBreakdown(null, { code: "MT02", date: week[4] }, C);
    const labels = explainFatigueFactors(daytime, { comparedWith: heavyEarly, candidateShift, preservesConsecutiveRecovery: true, config: C });
    expect(labels).toContain("Avoids third consecutive very-early shift");
    expect(labels).toContain("Lower recent early-shift burden");
    expect(labels).toContain("Preserves consecutive weekly recovery");
    expect(labels.length).toBeLessThanOrEqual(3);
  });

  it("names lower recent night-work burden", () => {
    const nights = run(["NT01", null, "NT01"]);
    const days = run(["NR01", null, "NR01"]);
    expect(explainFatigueFactors(days, { comparedWith: nights, config: C })).toContain("Lower recent night-work burden");
  });

  it("every label is digit-free and uses neutral operational wording; an unknown state is described honestly", () => {
    const states = [run(["MT02", "MT02", "MT02"]), run(["NT01", "NT01"]), run(["NR01", null, null]), run([])];
    const produced = new Set<string>();
    for (const s of states) for (const o of states) {
      for (const label of explainFatigueFactors(s, { comparedWith: o, preservesConsecutiveRecovery: true, maxReasons: 10, config: C })) {
        produced.add(label);
        expect(label).not.toMatch(/\d/);
        expect(label).not.toMatch(BANNED);
      }
    }
    expect(produced.size).toBeGreaterThanOrEqual(4); // the check above is not vacuous
    const unknownLabels = explainFatigueFactors(unknownFatigueState("none"), { config: C });
    expect(unknownLabels[0]).toMatch(/No prior-week workload history/);
    for (const l of unknownLabels) expect(l).not.toMatch(BANNED);
  });

  it("is deterministic", () => {
    const a = run(["MT02", "MT02"]);
    const b = run(["NR01", "NR01"]);
    expect(explainFatigueFactors(b, { comparedWith: a, maxReasons: 10, config: C })).toEqual(explainFatigueFactors(b, { comparedWith: a, maxReasons: 10, config: C }));
  });
});

describe("transport burden — architecture only, inert by default, never availability", () => {
  it("contributes exactly 0 by default even when a real transport context is supplied", () => {
    const lookup = lookupTransportContext("MT02", POST);
    expect(lookup.known).toBe(true);
    const ctx = lookup.known ? lookup.context : undefined;
    const withCtx = computeShiftBurdenBreakdown("MT02", POST, C, ctx);
    const without = computeShiftBurdenBreakdown("MT02", POST, C);
    expect(withCtx.transportComponent).toBe(0);
    expect(withCtx.dayBurden).toBe(without.dayBurden);
  });

  it("only a caller that explicitly opts in with a non-zero transportBurdenWeight gets a transport contribution", () => {
    const optIn = withWeights({ transportBurdenWeight: 0.5 });
    const lookup = lookupTransportContext("MT02", POST);
    const ctx = lookup.known ? lookup.context : undefined;
    expect(computeShiftBurdenBreakdown("MT02", POST, optIn, ctx).transportComponent).toBeGreaterThan(0);
  });

  it("the metadata lookup is honest about gaps and data-quality caveats instead of guessing", () => {
    expect(lookupTransportContext("MT02", PRE).known).toBe(false); // GMT-only metadata
    expect(lookupTransportContext("NR01", POST).known).toBe(false); // not covered
    expect(lookupTransportContext("JR02", POST).known).toBe(false); // sortie row earlier than JR02's own sortie — inconsistent
    const mt03 = lookupTransportContext("MT03", POST);
    expect(mt03.known && mt03.caveats.some((c) => c.includes("2027"))).toBe(true);
  });

  it("no fatigue output ever carries a shift_start/shift_end/eligibility/availability-shaped field", () => {
    const FORBIDDEN = /^(shift_start|shift_end|shiftStart|shiftEnd|start|end|eligible|isEligible|eligibility|available|availability|isAvailable|rest|restHours)$/i;
    const visit = (value: unknown, path: string) => {
      if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          expect(k, `${path}.${k}`).not.toMatch(FORBIDDEN);
          visit(v, `${path}.${k}`);
        }
      }
    };
    const optIn = withWeights({ transportBurdenWeight: 0.5 });
    const lookup = lookupTransportContext("AP03", POST);
    visit(lookup, "lookup");
    visit(computeShiftBurdenBreakdown("AP03", POST, optIn, lookup.known ? lookup.context : undefined), "breakdown");
    visit(computeDayBurdenBreakdown({ code: "NR01", date: POST }, { code: "AP03", date: "2026-09-23" }, optIn), "day");
    visit(accumulateFatigueOverDays(null, [{ code: "MT02", date: POST }, null, { code: "AP03", date: "2026-09-24" }], optIn, (s) => {
      const l = lookupTransportContext(s.code, s.date);
      return l.known ? l.context : undefined;
    }), "state");
  });

  it("nothing in the planning pipeline consumes the fatigue model yet — so it cannot change availability, eligibility, rest or coverage in this phase", () => {
    const planningDir = join(__dirname, "..", "lib", "planning");
    const importers = readdirSync(planningDir)
      .filter((f) => f.endsWith(".ts") && f !== "fatigue-model.ts" && f !== "fatigue-continuity.ts")
      .filter((f) => /from\s+["'][^"']*fatigue-(model|continuity|config)["']/.test(readFileSync(join(planningDir, f), "utf8")));
    expect(importers).toEqual([]);
    const scoring = readFileSync(join(__dirname, "..", "lib", "scoring.ts"), "utf8");
    expect(scoring).not.toMatch(/fatigue/i);
  });
});
