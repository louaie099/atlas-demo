import { describe, it, expect } from "vitest";
import { deriveIncomingOffBlockState, OffBlockSeedInput, IncomingOffBlockState } from "../lib/planning/off-block-continuity";
import { generateDraftWeeklyPlan } from "../lib/planning/generate-draft-plan";
import { buildDraftPlanBundle, planIdForWeek } from "../lib/planning/weekly-plan-service";
import { isFlexibleGeneralPool, isGenerationDrivenPopulation } from "../lib/planning/workforce-pools";
import { usesFixedCycleRotation } from "../lib/teams";
import { deriveTransitionContextFromPriorPlan, previousWeekStart } from "../lib/planning/rotation-context";
import { EMPLOYEES, FLIGHTS, CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_START, CURRENT_WEEK_LABEL } from "../lib/seed-data";
import { Employee, WeeklyPlanRosterEntry } from "../lib/types";

/**
 * OFF/OFF BLOCK BOUNDARY (off-block-continuity.ts) — "do not reset the
 * roster on Monday": when a generation-driven employee's prior PUBLISHED
 * week really ended with the FIRST (incomplete) day of a 2-day OFF/OFF
 * recovery block, this week's first day must complete it, rather than
 * independently choosing WORK and leaving that real OFF day isolated.
 */

function rosterRows(employeeId: string, pattern: ("work" | "off")[]): WeeklyPlanRosterEntry[] {
  return DAYS_WITH_DATA.map((d, i) => ({
    id: `r-${employeeId}-${d}`,
    plan_id: "prior",
    employee_id: employeeId,
    day_of_week: d,
    status: pattern[i] === "work" ? ("working" as const) : ("off" as const),
    shift_code: pattern[i] === "work" ? "MT02" : null,
  }));
}

function minimalEmployee(id: string, assignment: string): Employee {
  return {
    id,
    name: id,
    skills: ["Boarding"],
    assignment,
    shift_code: null,
    shift_start: null,
    shift_end: null,
    rest_before_shift_hours: null,
    weekly_hours: null,
    is_duty_officer: false,
    off_days: [],
    foreign_company_authorizations: [],
    active: true,
    weekly_shifts: DAYS_WITH_DATA.map((d) => ({ day_of_week: d, shift_code: "NR01", status: "working" as const })),
  };
}

describe("deriveIncomingOffBlockState", () => {
  const flexible = minimalEmployee("flex-1", "General T1 Pool");

  it("OFF W W W W W OFF: last day OFF, day before WORKED -> requires_first_day_off (the open block Monday must complete)", () => {
    const rows = rosterRows(flexible.id, ["off", "work", "work", "work", "work", "work", "off"]);
    const state = deriveIncomingOffBlockState(flexible, { kind: "prior_published_plan", priorPlanRosterEntries: rows, weekStart: "2026-09-07", daysOrder: DAYS_WITH_DATA });
    expect(state).toEqual({ source: "prior_plan", kind: "requires_first_day_off" });
  });

  it("W W W W W OFF OFF: last two days BOTH off -> satisfied (the block already completed within the prior week, no carry-over obligation)", () => {
    const rows = rosterRows(flexible.id, ["work", "work", "work", "work", "work", "off", "off"]);
    const state = deriveIncomingOffBlockState(flexible, { kind: "prior_published_plan", priorPlanRosterEntries: rows, weekStart: "2026-09-07", daysOrder: DAYS_WITH_DATA });
    expect(state).toEqual({ source: "prior_plan", kind: "satisfied" });
  });

  it("last day WORKED -> none (no OFF block open at the boundary at all)", () => {
    const rows = rosterRows(flexible.id, ["off", "off", "work", "work", "work", "work", "work"]);
    const state = deriveIncomingOffBlockState(flexible, { kind: "prior_published_plan", priorPlanRosterEntries: rows, weekStart: "2026-09-07", daysOrder: DAYS_WITH_DATA });
    expect(state).toEqual({ source: "prior_plan", kind: "none" });
  });

  it("no predecessor plan at all (first-ever week, or the prior week is still a draft) -> unknown, no constraint", () => {
    const state = deriveIncomingOffBlockState(flexible, { kind: "none" });
    expect(state.source).toBe("unknown");
    expect(state.kind).toBe("none");
  });

  it("employee absent from the predecessor plan's roster -> unknown, never a fabricated block", () => {
    const rows = rosterRows("someone-else", ["off", "work", "work", "work", "work", "work", "off"]);
    const state = deriveIncomingOffBlockState(flexible, { kind: "prior_published_plan", priorPlanRosterEntries: rows, weekStart: "2026-09-07", daysOrder: DAYS_WITH_DATA });
    expect(state.source).toBe("unknown");
  });

  it("fixed-cycle JR/NT/OFF/OFF teams are a no-op: their own continuous cycle already carries forward, this module never constrains them", () => {
    const fixedCycleEmployee = EMPLOYEES.find((e) => usesFixedCycleRotation(e.assignment));
    expect(fixedCycleEmployee).toBeDefined();
    const rows = rosterRows(fixedCycleEmployee!.id, ["off", "work", "work", "work", "work", "work", "off"]);
    const state = deriveIncomingOffBlockState(fixedCycleEmployee!, { kind: "prior_published_plan", priorPlanRosterEntries: rows, weekStart: "2026-09-07", daysOrder: DAYS_WITH_DATA });
    expect(state.source).toBe("unknown");
    expect(state.kind).toBe("none");
  });

  it("a non-generation-driven, still-static team (e.g. not in isGenerationDrivenPopulation) is also a no-op", () => {
    const staticEmployee = EMPLOYEES.find((e) => !usesFixedCycleRotation(e.assignment) && !isGenerationDrivenPopulation(e));
    if (!staticEmployee) return; // no such team in this seed data -- nothing to assert
    const rows = rosterRows(staticEmployee.id, ["off", "work", "work", "work", "work", "work", "off"]);
    const state = deriveIncomingOffBlockState(staticEmployee, { kind: "prior_published_plan", priorPlanRosterEntries: rows, weekStart: "2026-09-07", daysOrder: DAYS_WITH_DATA });
    expect(state.source).toBe("unknown");
  });
});

describe("wiring into generation — a required Monday OFF is actually enforced end to end", () => {
  const targetEmployee = EMPLOYEES.filter(isFlexibleGeneralPool)[0];

  function priorWeekRowsFor(employeeId: string): WeeklyPlanRosterEntry[] {
    // OFF, W, W, W, W, W, OFF -- Sunday is the open, incomplete first day
    // of a 2-day block (Saturday was worked).
    return rosterRows(employeeId, ["off", "work", "work", "work", "work", "work", "off"]);
  }

  it("REGRESSION (the spec's own example): a real employee whose prior published week ended OFF-W-W-W-W-W-OFF has this week's Monday forced OFF, even though demand would otherwise schedule them to work it", () => {
    const priorRows = priorWeekRowsFor(targetEmployee.id);
    const priorWeekStart = previousWeekStart(CURRENT_WEEK_START);
    const offBlockState = deriveIncomingOffBlockState(targetEmployee, {
      kind: "prior_published_plan",
      priorPlanRosterEntries: priorRows,
      weekStart: CURRENT_WEEK_START,
      daysOrder: DAYS_WITH_DATA,
    });
    expect(offBlockState.kind).toBe("requires_first_day_off");

    const priorWeekBoundaryContext = deriveTransitionContextFromPriorPlan(EMPLOYEES, priorRows, "Sunday", priorWeekStart);
    const incomingOffBlockState = new Map<string, IncomingOffBlockState>([[targetEmployee.id, offBlockState]]);

    // WITHOUT the fix (the exact bug this milestone closes): the existing
    // priorDayOffEmployeeIds guard treats "known OFF the day before" as a
    // reason to AVOID a window touching Monday (it exists to stop an
    // ALREADY-closed OFF run from being extended) -- so the old wiring, if
    // anything, steers this employee TOWARD working Monday, never away
    // from it.
    const withoutFix = generateDraftWeeklyPlan(
      FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_LABEL, CURRENT_WEEK_START,
      priorWeekBoundaryContext, "prior_plan", {}
    );
    const mondayWithoutFix = withoutFix.rosterEntries.find((r) => r.employee_id === targetEmployee.id && r.day_of_week === "Monday");
    expect(mondayWithoutFix?.status).toBe("working"); // demonstrates the old-behavior baseline this fix corrects

    // WITH the fix: the same real demand, the same prior-week context, plus
    // the derived off-block state -- Monday MUST be OFF for this employee.
    const withFix = generateDraftWeeklyPlan(
      FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_LABEL, CURRENT_WEEK_START,
      priorWeekBoundaryContext, "prior_plan", { incomingOffBlockState }
    );
    const mondayWithFix = withFix.rosterEntries.find((r) => r.employee_id === targetEmployee.id && r.day_of_week === "Monday");
    expect(mondayWithFix?.status).toBe("off");
  });

  it("INVERSE: a block already satisfied within the prior week (both trailing days OFF) imposes no constraint -- generation is byte-identical to omitting the off-block state entirely, and the employee's Tuesday onward stays free", () => {
    const priorRows = rosterRows(targetEmployee.id, ["work", "work", "work", "work", "work", "off", "off"]);
    const priorWeekStart = previousWeekStart(CURRENT_WEEK_START);
    const offBlockState = deriveIncomingOffBlockState(targetEmployee, {
      kind: "prior_published_plan",
      priorPlanRosterEntries: priorRows,
      weekStart: CURRENT_WEEK_START,
      daysOrder: DAYS_WITH_DATA,
    });
    expect(offBlockState.kind).toBe("satisfied");
    const priorWeekBoundaryContext = deriveTransitionContextFromPriorPlan(EMPLOYEES, priorRows, "Sunday", priorWeekStart);
    const incomingOffBlockState = new Map<string, IncomingOffBlockState>([[targetEmployee.id, offBlockState]]);

    const withState = generateDraftWeeklyPlan(
      FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_LABEL, CURRENT_WEEK_START,
      priorWeekBoundaryContext, "prior_plan", { incomingOffBlockState }
    );
    const withoutState = generateDraftWeeklyPlan(
      FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_LABEL, CURRENT_WEEK_START,
      priorWeekBoundaryContext, "prior_plan", {}
    );
    expect(withState.rosterEntries).toEqual(withoutState.rosterEntries);
  });

  it("NO PRIOR PUBLISHED WEEK (first week ever, or the prior week is still a draft): unknown, current behavior preserved exactly -- byte-identical to never having supplied an off-block state at all", () => {
    const unknownState: IncomingOffBlockState = deriveIncomingOffBlockState(targetEmployee, { kind: "none" });
    expect(unknownState.source).toBe("unknown");
    const incomingOffBlockState = new Map<string, IncomingOffBlockState>(EMPLOYEES.map((e) => [e.id, unknownState]));

    const withUnknownState = generateDraftWeeklyPlan(
      FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_LABEL, CURRENT_WEEK_START,
      new Map(), "unknown", { incomingOffBlockState }
    );
    const withNoStateAtAll = generateDraftWeeklyPlan(
      FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_LABEL, CURRENT_WEEK_START,
      new Map(), "unknown", {}
    );
    expect(withUnknownState.rosterEntries).toEqual(withNoStateAtAll.rosterEntries);
  });
});

describe("weekly-plan-service wiring — buildDraftPlanBundle only trusts a PUBLISHED predecessor", () => {
  const targetEmployee = EMPLOYEES.filter(isFlexibleGeneralPool)[0];

  it("the SAME predecessor roster forces Monday OFF when flagged published, but not when it is (implicitly) still a draft", () => {
    const priorRows = rosterRows(targetEmployee.id, ["off", "work", "work", "work", "work", "work", "off"]);
    const priorWeekStart = previousWeekStart(CURRENT_WEEK_START);
    const priorWeekBoundaryContext = deriveTransitionContextFromPriorPlan(EMPLOYEES, priorRows, "Sunday", priorWeekStart);

    const published = buildDraftPlanBundle({
      planId: planIdForWeek(CURRENT_WEEK_START),
      weekStart: CURRENT_WEEK_START,
      weekLabel: CURRENT_WEEK_LABEL,
      revision: 1,
      flights: FLIGHTS,
      employees: EMPLOYEES,
      config: CONFIG,
      daysOrder: DAYS_WITH_DATA,
      priorWeekBoundaryContext,
      priorPlanRosterEntries: priorRows,
      priorWeekPublished: true,
    });
    const draftPredecessor = buildDraftPlanBundle({
      planId: planIdForWeek(CURRENT_WEEK_START),
      weekStart: CURRENT_WEEK_START,
      weekLabel: CURRENT_WEEK_LABEL,
      revision: 1,
      flights: FLIGHTS,
      employees: EMPLOYEES,
      config: CONFIG,
      daysOrder: DAYS_WITH_DATA,
      priorWeekBoundaryContext,
      priorPlanRosterEntries: priorRows,
      // priorWeekPublished omitted -- exactly how a caller that looked up a
      // DRAFT predecessor would call this (see weekly-plan-service.ts's
      // lookupPriorWeekBoundaryContext, whose `published` is false for a draft).
    });

    const mondayPublished = published.rosterEntries.find((r) => r.employee_id === targetEmployee.id && r.day_of_week === "Monday");
    const mondayDraftPredecessor = draftPredecessor.rosterEntries.find((r) => r.employee_id === targetEmployee.id && r.day_of_week === "Monday");

    expect(mondayPublished?.status).toBe("off");
    expect(mondayDraftPredecessor?.status).toBe("working");
  });
});
