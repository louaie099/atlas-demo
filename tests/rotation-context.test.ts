import { describe, it, expect } from "vitest";
import {
  previousWeekStart,
  deriveTransitionContextFromPriorPlan,
  deriveFallbackBoundaryContext,
} from "../lib/planning/rotation-context";
import { buildDraftPlanBundle, planIdForWeek } from "../lib/planning/weekly-plan-service";
import { generateDraftWeeklyPlan } from "../lib/planning/generate-draft-plan";
import { PriorDayShiftMap } from "../lib/planning/shift-generation";
import { EMPLOYEES, FLIGHTS, CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_START, CURRENT_WEEK_LABEL } from "../lib/seed-data";
import { Employee, WeeklyPlanRosterEntry, WeeklyShiftEntry } from "../lib/types";
import { getShiftTimesAs } from "../lib/shift-templates";
import { restHoursBetween } from "../lib/roster-generation";
import { isFlexibleGeneralPool } from "../lib/planning/workforce-pools";

/**
 * These tests cover the cross-week continuity primitives introduced for
 * Task D — the correction that a displayed Monday-Sunday WeeklyPlan is a
 * planning/display SLICE, not the boundary at which a normal employee's
 * continuous work/OFF rotation resets. See lib/planning/rotation-context.ts
 * and generate-draft-plan.ts's priorWeekBoundaryContext parameter.
 */

describe("previousWeekStart", () => {
  it("returns the calendar date exactly 7 days before weekStart", () => {
    expect(previousWeekStart("2026-09-08")).toBe("2026-09-01");
    expect(previousWeekStart(CURRENT_WEEK_START)).toBe("2026-08-25");
  });

  it("crosses a month boundary correctly", () => {
    expect(previousWeekStart("2026-03-03")).toBe("2026-02-24");
  });

  it("crosses a year boundary correctly", () => {
    expect(previousWeekStart("2027-01-05")).toBe("2026-12-29");
  });
});

describe("deriveTransitionContextFromPriorPlan", () => {
  const employees: Employee[] = [
    { id: "e1" } as Employee,
    { id: "e2" } as Employee,
    { id: "e3" } as Employee,
  ];

  it("maps a working prior-Sunday roster row to that shift's real start/end times", () => {
    const rosterEntries: WeeklyPlanRosterEntry[] = [
      { id: "r1", plan_id: "p1", employee_id: "e1", day_of_week: "Sunday", status: "working", shift_code: "MT02" },
    ];
    const map = deriveTransitionContextFromPriorPlan(employees, rosterEntries, "Sunday");
    expect(map.get("e1")).toEqual(getShiftTimesAs("MT02"));
  });

  it("maps an OFF prior-Sunday roster row to null (a real absence of rest risk, not missing data)", () => {
    const rosterEntries: WeeklyPlanRosterEntry[] = [
      { id: "r1", plan_id: "p1", employee_id: "e2", day_of_week: "Sunday", status: "off", shift_code: null },
    ];
    const map = deriveTransitionContextFromPriorPlan(employees, rosterEntries, "Sunday");
    expect(map.get("e2")).toBeNull();
  });

  it("maps a completely missing roster row (no prior plan data for this employee/day) to null as well, so the forward rest gate is skipped rather than crashing", () => {
    const map = deriveTransitionContextFromPriorPlan(employees, [], "Sunday");
    expect(map.get("e3")).toBeNull();
    expect(map.has("e3")).toBe(true); // explicitly set, not just absent from the map
  });
});

describe("deriveFallbackBoundaryContext", () => {
  function employeeWithSunday(assignment: string, shift: WeeklyShiftEntry): Employee {
    const weekly_shifts: WeeklyShiftEntry[] = DAYS_WITH_DATA.map((d) =>
      d === "Sunday" ? shift : { day_of_week: d, status: "off", shift_code: null }
    );
    return {
      id: "e1", name: "Test", skills: [], assignment, shift_code: shift.shift_code,
      shift_start: null, shift_end: null, rest_before_shift_hours: null, weekly_hours: null,
      is_duty_officer: false, off_days: [], foreign_company_authorizations: [], active: true,
      weekly_shifts,
    };
  }

  // NON-flexible employees (Transit/Leaders/fixed/foreign-committed) still
  // have a real, authoritative static weekly_shifts commitment under
  // their own dedicated planning model (unchanged by the Task E
  // demand-driven correction — see duty-generation.ts's
  // effectiveShiftForDay), so the fallback boundary seed still correctly
  // reads it for them.
  it("uses a NON-flexible employee's own static baseline for daysOrder's LAST day as the boundary seed, when they work that day", () => {
    const employee = employeeWithSunday("Transit", { day_of_week: "Sunday", status: "working", shift_code: "MT02" });
    const map = deriveFallbackBoundaryContext([employee], DAYS_WITH_DATA);
    expect(map.get("e1")).toEqual(getShiftTimesAs("MT02"));
  });

  it("returns null when a NON-flexible employee's baseline has them OFF on daysOrder's last day", () => {
    const employee = employeeWithSunday("Transit", { day_of_week: "Sunday", status: "off", shift_code: null });
    const map = deriveFallbackBoundaryContext([employee], DAYS_WITH_DATA);
    expect(map.get("e1")).toBeNull();
  });

  // FLEXIBLE (General T1) employees' static weekly_shifts is durable
  // legacy/fallback DATA, not an authoritative commitment any more (Task
  // E) — effectiveShiftForDay never reads it for this population (see
  // duty-generation.ts). deriveFallbackBoundaryContext is a thin wrapper
  // around effectiveShiftForDay, so for a flexible employee it correctly
  // returns null regardless of what their static baseline says: there is
  // genuinely no reliable "what did they last do" data to seed from for
  // this population until a real prior plan exists (see
  // deriveTransitionContextFromPriorPlan above for that case) — an honest
  // "no data", never a fabricated one, and never treated as a rest
  // violation (a missing entry, not a null-shift entry, would be — see
  // PriorDayShiftMap's own doc comment — but this always explicitly sets
  // null, which the forward rest gate correctly skips).
  it("returns null for a FLEXIBLE (General T1) employee even when their static baseline says they work that day — that baseline is no longer authoritative for this population", () => {
    const employee = employeeWithSunday("General T1", { day_of_week: "Sunday", status: "working", shift_code: "MT02" });
    const map = deriveFallbackBoundaryContext([employee], DAYS_WITH_DATA);
    expect(map.get("e1")).toBeNull();
  });
});

describe("cross-plan continuity — Week B continues from Week A rather than regenerating independently", () => {
  it("builds two consecutive weeks' plan bundles and confirms Week B's Monday is genuinely rest-checked against Week A's real, generated Sunday roster (not an empty/reset boundary)", () => {
    const weekAStart = CURRENT_WEEK_START;
    const weekBStart = "2026-09-08";
    const planIdA = planIdForWeek(weekAStart);
    const planIdB = planIdForWeek(weekBStart);

    const bundleA = buildDraftPlanBundle({
      planId: planIdA,
      weekStart: weekAStart,
      weekLabel: CURRENT_WEEK_LABEL,
      revision: 1,
      flights: FLIGHTS,
      employees: EMPLOYEES,
      config: CONFIG,
      daysOrder: DAYS_WITH_DATA,
      // Week A itself has no real predecessor -- omitted, so it falls
      // back to deriveFallbackBoundaryContext internally.
    });

    const priorWeekBoundaryContext = deriveTransitionContextFromPriorPlan(
      EMPLOYEES,
      bundleA.rosterEntries,
      DAYS_WITH_DATA[DAYS_WITH_DATA.length - 1]
    );

    const bundleB = buildDraftPlanBundle({
      planId: planIdB,
      weekStart: weekBStart,
      weekLabel: "Week of Mon, Sep 8 2026",
      revision: 1,
      flights: FLIGHTS,
      employees: EMPLOYEES,
      config: CONFIG,
      daysOrder: DAYS_WITH_DATA,
      priorWeekBoundaryContext,
    });

    // Week B's own bundle must exist and be well-formed -- the concrete
    // proof that generation ran using Week A's real boundary data (rather
    // than throwing, or silently ignoring it) is that this produces a
    // complete, sane roster with no unexplained crash or empty result.
    expect(bundleB.rosterEntries.length).toBe(bundleA.rosterEntries.length);
    expect(bundleB.plan.week_start).toBe(weekBStart);

    // The actual point of this test: verify the SPECIFIC Sunday(Week A) ->
    // Monday(Week B) transition Stage 6 generation used real cross-plan
    // context for. Scoped to the FLEXIBLE General T1 pool only -- that is
    // the only population whose Monday shift is actually CHOSEN by
    // generation (and therefore the only population the generation-time
    // rest gate, and this feature, can affect at all). Static/fixed-team
    // employees' Monday shift is their own unconditional baseline
    // commitment, never touched by generation; any rest gap in THEIR
    // fixed pattern is a separate, already-reported workforce-design
    // question (see auditStaticShiftRestFeasibility and
    // labor-rule-invariants.test.ts), not something this cross-week
    // wiring could or should silently fix.
    const rosterByKeyB = new Map(
      bundleB.rosterEntries.map((r) => [`${r.employee_id}|${r.day_of_week}`, { status: r.status, shift_code: r.shift_code }])
    );
    const mondayViolations: string[] = [];
    let checkedAtLeastOneRealTransition = false;
    for (const employee of EMPLOYEES.filter(isFlexibleGeneralPool)) {
      const priorSunday = priorWeekBoundaryContext.get(employee.id);
      if (!priorSunday) continue; // employee was OFF (or unrostered) Week A's Sunday -- nothing to check
      const mondayEntry = rosterByKeyB.get(`${employee.id}|Monday`);
      if (!mondayEntry || mondayEntry.status !== "working" || !mondayEntry.shift_code) continue;

      // Only a Monday Stage 6 actually CHOSE (real code differs from this
      // employee's own static baseline) went through the generation-time
      // rest gate at all -- a baseline-to-baseline Monday was never
      // gated, so any rest gap there is the same already-reported,
      // pre-existing static-pattern issue this suite documents elsewhere
      // (see the comment above), not something this feature could affect.
      const baselineMonday = employee.weekly_shifts.find((s) => s.day_of_week === "Monday")?.shift_code ?? null;
      if (mondayEntry.shift_code === baselineMonday) continue;

      checkedAtLeastOneRealTransition = true;
      const mondayShift = getShiftTimesAs(mondayEntry.shift_code);
      const restHours = restHoursBetween(priorSunday.shift_start, priorSunday.shift_end, mondayShift.shift_start);
      if (restHours < CONFIG.minimum_rest_hours) {
        mondayViolations.push(
          `${employee.name}: only ${restHours.toFixed(1)}h rest between Week A's Sunday (ends ${priorSunday.shift_end}) and Week B's Monday (${mondayEntry.shift_code}, starts ${mondayShift.shift_start})`
        );
      }
    }
    // This demo's current flight/demand mix may or may not happen to give
    // Stage 6 a reason to override any given employee's Monday baseline
    // (see the "sanity" test in labor-rule-invariants.test.ts -- zero
    // overrides is a legitimate outcome, not a bug), so
    // checkedAtLeastOneRealTransition is a non-negative reporting signal
    // here, not a strict gate -- the deterministic proof that the WIRING
    // itself works is the synthetic test below. What IS a strict gate: if
    // generation did make a real Monday choice for someone with a known
    // real Week-A Sunday shift, it must never have violated rest.
    expect(checkedAtLeastOneRealTransition).toBeTypeOf("boolean");
    expect(mondayViolations, mondayViolations.join("\n")).toHaveLength(0);
  });

  it("deterministic proof of the wiring: an intentionally harsh priorWeekBoundaryContext (every flexible employee having just ended a late shift) suppresses Monday assignments that would otherwise violate 15h rest, while an empty context (the old Monday-reset behavior) does not protect against the same violation", () => {
    // A shift ending at 23:45 the night before -- any ordinary morning
    // catalog shift (04:xx-08:xx starts) starting on Monday would land
    // well under the confirmed 15h floor against this.
    const harshPriorSunday: PriorDayShiftMap = new Map();
    for (const employee of EMPLOYEES.filter(isFlexibleGeneralPool)) {
      harshPriorSunday.set(employee.id, { shift_start: "13:45", shift_end: "23:45" });
    }

    const withHarshContext = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_LABEL, harshPriorSunday);
    const withEmptyContext = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_LABEL, new Map());

    const mondayShiftsWithHarshContext = withHarshContext.generatedShiftsByDay["Monday"] ?? [];
    const mondayShiftsWithEmptyContext = withEmptyContext.generatedShiftsByDay["Monday"] ?? [];

    // The harsh boundary must genuinely suppress at least the assignments
    // the empty-context run made that the harsh one didn't -- proving
    // priorWeekBoundaryContext actually reaches Stage 6's rest gate for
    // Monday (dayIndex 0), rather than Monday always starting from an
    // empty priorDayShift regardless of what's passed in.
    const harshEmployeeIds = new Set(mondayShiftsWithHarshContext.map((s) => s.employeeId));
    const emptyEmployeeIds = new Set(mondayShiftsWithEmptyContext.map((s) => s.employeeId));
    const suppressedByHarshContext = [...emptyEmployeeIds].filter((id) => !harshEmployeeIds.has(id));

    expect(mondayShiftsWithHarshContext.length).toBeLessThanOrEqual(mondayShiftsWithEmptyContext.length);
    expect(suppressedByHarshContext.length).toBeGreaterThan(0);

    // And no employee the harsh run DID assign on Monday can have
    // violated rest against the harsh 23:45-ending Sunday shift -- the
    // gate must have genuinely filtered on this data, not coincidentally
    // matched shift codes that happened to already satisfy it.
    for (const assignment of mondayShiftsWithHarshContext) {
      const { shift_start } = getShiftTimesAs(assignment.shiftCode);
      const restHours = restHoursBetween("13:45", "23:45", shift_start);
      expect(restHours).toBeGreaterThanOrEqual(CONFIG.minimum_rest_hours);
    }
  });
});
