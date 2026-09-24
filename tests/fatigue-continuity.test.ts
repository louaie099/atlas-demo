import { describe, it, expect } from "vitest";
import { deriveIncomingFatigueState, fatigueSeedKindFor } from "../lib/planning/fatigue-continuity";
import { deriveFallbackBoundaryContext, deriveFallbackContextForDay, previousWeekStart } from "../lib/planning/rotation-context";
import { accumulateFatigueOverDays, neutralFatigueState, ShiftOnDate } from "../lib/planning/fatigue-model";
import { PROTOTYPE_FATIGUE_CONFIG, DEFAULT_FATIGUE_CONFIG } from "../lib/fatigue-config";
import { flightDateFor } from "../lib/flight-date";
import { EMPLOYEES } from "../lib/seed-data";
import { usesFixedCycleRotation } from "../lib/teams";
import { Employee, WeeklyPlanRosterEntry } from "../lib/types";

const C = PROTOTYPE_FATIGUE_CONFIG;
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function flexibleAce(id: string): Employee {
  return {
    id, name: id, skills: ["Boarding"], assignment: "General T1 Pool",
    shift_code: null, shift_start: null, shift_end: null, rest_before_shift_hours: null, weekly_hours: null,
    is_duty_officer: false, off_days: [], foreign_company_authorizations: [], active: true,
    weekly_shifts: DAYS.map((d) => ({ day_of_week: d, shift_code: "NR01", status: "working" as const })),
  };
}

function rosterRows(employeeId: string, codes: (string | null)[]): WeeklyPlanRosterEntry[] {
  return DAYS.map((d, i) => ({
    id: `r-${employeeId}-${d}`, plan_id: "prior", employee_id: employeeId, day_of_week: d,
    status: codes[i] ? ("working" as const) : ("off" as const), shift_code: codes[i],
  }));
}

describe("deriveIncomingFatigueState — real history vs static fallback vs genuinely unknown", () => {
  const ace = flexibleAce("ace-1");
  const priorCodes = ["MT02", "MT02", "MT02", "MT02", "MT02", null, null];

  it("REAL predecessor plan: returns a known state tagged prior_plan, built from that plan's actual roster", () => {
    const seed = deriveIncomingFatigueState(ace, { kind: "prior_plan", priorPlanRosterEntries: rosterRows("ace-1", priorCodes), weekStart: "2026-09-07", daysOrder: DAYS }, C);
    expect(seed.source).toBe("prior_plan");
    expect(seed.state.known).toBe(true);
    if (!seed.state.known) throw new Error("unreachable");
    expect(seed.state.provenance).toBe("prior_plan");
    expect(seed.state.daysObserved).toBe(7);
    expect(seed.state.accumulatedBurden).toBeGreaterThan(0);
    expect(seed.state.consecutiveOffDays).toBe(2); // the week ended on OFF/OFF
    expect("approximate" in seed).toBe(false);
  });

  it("the prior-plan seed (via rotation-context's own derivation) equals folding the same real codes on their real prior-week dates — including a prior week straddling 2026-09-20", () => {
    const weekStart = "2026-09-21"; // prior week 2026-09-14..2026-09-20: Saturday is pre-regime, Sunday post-regime
    const codes = ["NR01", "MT02", null, "AP01", "AP02", "MT02", "MT02"];
    const seed = deriveIncomingFatigueState(ace, { kind: "prior_plan", priorPlanRosterEntries: rosterRows("ace-1", codes), weekStart, daysOrder: DAYS }, C);
    const priorWeek = previousWeekStart(weekStart);
    const direct = accumulateFatigueOverDays(
      neutralFatigueState("prior_plan"),
      codes.map((c, i): ShiftOnDate | null => (c ? { code: c, date: flightDateFor(priorWeek, DAYS[i]) } : null)),
      C
    );
    if (!seed.state.known) throw new Error("expected a known state");
    expect(seed.state.accumulatedBurden).toBeCloseTo(direct.accumulatedBurden, 10);
    expect(seed.state.recent).toEqual(direct.recent);
  });

  it("an employee ABSENT from the predecessor plan is unknown — not treated as a week of OFF days", () => {
    const seed = deriveIncomingFatigueState(ace, { kind: "prior_plan", priorPlanRosterEntries: rosterRows("someone-else", priorCodes), weekStart: "2026-09-07", daysOrder: DAYS }, C);
    expect(seed.source).toBe("unknown");
    expect(seed.state.known).toBe(false);
  });

  it("STATIC FALLBACK for a fixed-cycle employee: known, tagged fallback_static_baseline, and explicitly flagged approximate", () => {
    const fixed = EMPLOYEES.find((e) => usesFixedCycleRotation(e.assignment) && e.weekly_shifts.some((s) => s.status === "working"))!;
    expect(fixed).toBeDefined();
    const seed = deriveIncomingFatigueState(fixed, { kind: "fallback_static_baseline", weekStart: "2026-09-07", daysOrder: DAYS }, C);
    expect(seed.source).toBe("fallback_static_baseline");
    expect(seed.source === "fallback_static_baseline" && seed.approximate).toBe(true);
    if (!seed.state.known) throw new Error("expected a known state");
    expect(seed.state.provenance).toBe("fallback_static_baseline");
    expect(seed.state.accumulatedBurden).toBeGreaterThan(0);
  });

  it("STATIC FALLBACK for a demand-driven (flexible) employee is UNKNOWN — the baseline is not authoritative for them, so no history is fabricated from it", () => {
    // Even though this ACE's static weekly_shifts says NR01 every day.
    const seed = deriveIncomingFatigueState(ace, { kind: "fallback_static_baseline", weekStart: "2026-09-07", daysOrder: DAYS }, C);
    expect(seed.source).toBe("unknown");
    expect(seed.state.known).toBe(false);
    expect(seed.state).not.toHaveProperty("accumulatedBurden");
  });

  it("NO CONTEXT AT ALL (first-ever week): an explicit unknown state with a reason, never an invented previous week", () => {
    const seed = deriveIncomingFatigueState(ace, { kind: "none" }, C);
    expect(seed.source).toBe("unknown");
    expect(seed.state).toEqual({ known: false, reason: expect.any(String) });
  });

  it("the three outcomes have distinct shapes, and provenance maps onto the seed kind", () => {
    expect(fatigueSeedKindFor("prior_plan")).toBe("prior_plan");
    expect(fatigueSeedKindFor("fallback_static_baseline")).toBe("fallback_static_baseline");
    expect(fatigueSeedKindFor("unknown")).toBe("none");
  });

  it("under the default (disabled) config the seed keeps its provenance but carries zero burden", () => {
    const seed = deriveIncomingFatigueState(ace, { kind: "prior_plan", priorPlanRosterEntries: rosterRows("ace-1", priorCodes), weekStart: "2026-09-07", daysOrder: DAYS }, DEFAULT_FATIGUE_CONFIG);
    expect(seed.source).toBe("prior_plan");
    if (!seed.state.known) throw new Error("expected a known state");
    expect(seed.state.accumulatedBurden).toBe(0);
  });
});

describe("rotation-context refactor — deriveFallbackBoundaryContext is unchanged", () => {
  it("equals the new per-day core applied to the window's last day", () => {
    for (const weekStart of ["2026-08-31", "2026-09-21"]) {
      expect(deriveFallbackBoundaryContext(EMPLOYEES, DAYS, weekStart)).toEqual(deriveFallbackContextForDay(EMPLOYEES, "Sunday", weekStart));
    }
  });
});
