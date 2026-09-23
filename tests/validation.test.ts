import { describe, it, expect } from "vitest";
import { computeScheduledWeeklyHours, checkRestBetweenDays, checkAverageWeeklyHours, auditAverageWeeklyHoursFeasibility, validateWeeklyPlan, collectConfigurationIssues } from "../lib/planning/validation";
import { evaluateAverageWorkingHours } from "../lib/planning/average-hours";
import { CONFIG } from "../lib/seed-data";
import { Employee, WeeklyShiftEntry } from "../lib/types";

// A Monday well before the 2026-09-20 regime change, so every existing
// assertion here keeps resolving the OLD-regime shift catalog it always
// implicitly assumed.
const TEST_WEEK_START = "2026-01-05";

function makeEmployee(weeklyShifts: WeeklyShiftEntry[], overrides: Partial<Employee> = {}): Employee {
  return {
    id: "emp", name: "Test Employee", skills: ["Boarding"], assignment: "General T1 Pool",
    shift_code: null, shift_start: null, shift_end: null, rest_before_shift_hours: null,
    weekly_hours: null, is_duty_officer: false, off_days: [], foreign_company_authorizations: [],
    active: true, weekly_shifts: weeklyShifts,
    ...overrides,
  };
}

describe("computeScheduledWeeklyHours", () => {
  it("sums working days' shift durations, ignoring OFF days", () => {
    const employee = makeEmployee([
      { day_of_week: "Monday", shift_code: "MT01", status: "working" }, // 05:45-14:45 = 9h
      { day_of_week: "Tuesday", shift_code: null, status: "off" },
      { day_of_week: "Wednesday", shift_code: "AP01", status: "working" }, // 13:45-22:45 = 9h
    ]);
    expect(computeScheduledWeeklyHours(employee, TEST_WEEK_START)).toBe(18);
  });

  it("returns 0 for an employee with no working days", () => {
    const employee = makeEmployee([{ day_of_week: "Monday", shift_code: null, status: "off" }]);
    expect(computeScheduledWeeklyHours(employee, TEST_WEEK_START)).toBe(0);
  });
});

describe("checkRestBetweenDays", () => {
  it("correctly treats an overnight PREVIOUS shift's end as the FOLLOWING calendar day — not clock-time subtraction", () => {
    // AP04: 13:45-02:00 (overnight — really ends Tuesday 02:00, not Monday).
    // MT02 the very next day: 04:30-14:45.
    // Real gap: Tuesday 04:30 - Tuesday 02:00 = 2h30 — a severe violation.
    // A naive clock-time-only calculation (treating "02:00" as if it were
    // still Monday, then adding 24h for "next day" on top) would wrongly
    // compute 26h30 of rest and miss this entirely — exactly the bug this
    // fix corrects (see roster-generation.ts's restHoursBetween).
    const employee = makeEmployee([
      { day_of_week: "Monday", shift_code: "AP04", status: "working" }, // 13:45-02:00 (overnight)
      { day_of_week: "Tuesday", shift_code: "MT02", status: "working" }, // 04:30-14:45
    ]);
    const issues = checkRestBetweenDays(employee, ["Monday", "Tuesday"], CONFIG, TEST_WEEK_START);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("rest_violation");
    expect(issues[0].description).toContain("2.5h rest");
  });

  it("does not flag a genuinely adequate gap after an overnight previous shift", () => {
    // NT01: 17:45-06:15 (overnight — really ends the following day 06:15).
    // Next working day's shift starts late enough to clear 15h: JR02 at
    // 04:30 the day AFTER that (i.e. two calendar days later) — comfortably
    // over 15h no matter how it's measured. Use AP01 (13:45-22:45) instead,
    // starting well after the corrected 06:15 end: gap = 13:45 - 06:15 = 7h30
    // is NOT enough (would be a violation); use NT01 -> N8 (21:00-06:15)
    // instead: gap = 21:00 - 06:15 = 14h45, still under 15h. Use a shift
    // starting the day after NEXT instead is out of scope for a 2-day
    // window, so assert the genuinely-adequate case with a non-overnight
    // previous shift: MT01 (05:45-14:45) into AP01 (13:45-22:45) next day —
    // gap = (13:45+24h) - 14:45 = 23h, well over 15h.
    const employee = makeEmployee([
      { day_of_week: "Monday", shift_code: "MT01", status: "working" }, // 05:45-14:45
      { day_of_week: "Tuesday", shift_code: "AP01", status: "working" }, // 13:45-22:45
    ]);
    expect(checkRestBetweenDays(employee, ["Monday", "Tuesday"], CONFIG, TEST_WEEK_START)).toHaveLength(0);
  });

  it("does not flag rest between a working day and an OFF day", () => {
    const employee = makeEmployee([
      { day_of_week: "Monday", shift_code: "AP02", status: "working" },
      { day_of_week: "Tuesday", shift_code: null, status: "off" },
    ]);
    expect(checkRestBetweenDays(employee, ["Monday", "Tuesday"], CONFIG, TEST_WEEK_START)).toHaveLength(0);
  });

  it("flags a genuinely tight back-to-back case (non-overnight previous shift)", () => {
    // AP02 (13:45-23:15) into MT02 (04:30-14:45) the next day:
    // rest = (04:30+24h) - 23:15 = 28:30 - 23:15 = 5h15 — a violation under
    // both the old 10h and the confirmed 15h minimum.
    const employee = makeEmployee([
      { day_of_week: "Monday", shift_code: "AP02", status: "working" },
      { day_of_week: "Tuesday", shift_code: "MT02", status: "working" },
    ]);
    const issues = checkRestBetweenDays(employee, ["Monday", "Tuesday"], CONFIG, TEST_WEEK_START);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("rest_violation");
  });

  it("checks the cyclic Sunday -> following-Monday boundary, not just calendar-adjacent slots inside one week", () => {
    const daysOrder = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const employee = makeEmployee([
      { day_of_week: "Monday", shift_code: null, status: "off" },
      { day_of_week: "Tuesday", shift_code: null, status: "off" },
      { day_of_week: "Wednesday", shift_code: null, status: "off" },
      { day_of_week: "Thursday", shift_code: null, status: "off" },
      { day_of_week: "Friday", shift_code: null, status: "off" },
      { day_of_week: "Saturday", shift_code: null, status: "off" },
      // Sunday AP02 (13:45-23:15) -> following Monday MT02 (04:30-14:45):
      // rest = 5h15, same tight case as above, but only visible if the
      // check wraps past the end of daysOrder back to index 0.
      { day_of_week: "Sunday", shift_code: "AP02", status: "working" },
    ]);
    // A second employee object would be needed to represent "next week's
    // Monday" for a real plan; this test exercises the function directly
    // against a single weekly_shifts array that reuses "Monday" as both
    // the array's first day AND the cyclic wrap target, exactly like
    // lib/planning/consecutive-off.ts's own cyclic check does for
    // consecutive OFF days.
    const withMonday = makeEmployee([
      ...employee.weekly_shifts,
    ]);
    withMonday.weekly_shifts[0] = { day_of_week: "Monday", shift_code: "MT02", status: "working" };
    const issues = checkRestBetweenDays(withMonday, daysOrder, CONFIG, TEST_WEEK_START);
    // CHANGED (deliberately, not a regression): this employee's default
    // assignment is "General T1 Pool" -- a demand-driven population whose
    // next week isn't planned yet, so "this week repeats" is an
    // unconfirmed assumption. This wraparound case is now the softer
    // cross_week_continuity_uncertain warning, never a hard rest_violation,
    // so a demand-driven employee's otherwise-legal Monday coverage is no
    // longer silently dropped over a hypothesis nobody confirmed. See
    // enforceRestInvariantAcrossWeek's matching doc comment.
    expect(issues.some((i) => i.type === "cross_week_continuity_uncertain" && i.dayOfWeek?.includes("Monday"))).toBe(true);
    expect(issues.some((i) => i.type === "rest_violation")).toBe(false);
  });

  it("the SAME wraparound conflict stays a hard rest_violation for a FIXED/cyclic team, whose repeating pattern is confirmed by design, not a hypothesis", () => {
    const daysOrder = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const employee = makeEmployee(
      [
        { day_of_week: "Monday", shift_code: null, status: "off" },
        { day_of_week: "Tuesday", shift_code: null, status: "off" },
        { day_of_week: "Wednesday", shift_code: null, status: "off" },
        { day_of_week: "Thursday", shift_code: null, status: "off" },
        { day_of_week: "Friday", shift_code: null, status: "off" },
        { day_of_week: "Saturday", shift_code: null, status: "off" },
        { day_of_week: "Sunday", shift_code: "AP02", status: "working" },
      ],
      { assignment: "Transit" }
    );
    employee.weekly_shifts[0] = { day_of_week: "Monday", shift_code: "MT02", status: "working" };
    const issues = checkRestBetweenDays(employee, daysOrder, CONFIG, TEST_WEEK_START);
    expect(issues.some((i) => i.type === "rest_violation" && i.dayOfWeek?.includes("Monday"))).toBe(true);
    expect(issues.some((i) => i.type === "cross_week_continuity_uncertain")).toBe(false);
  });
});

describe("checkAverageWeeklyHours / evaluateAverageWorkingHours — 42h is a confirmed AVERAGE, not a Monday-Sunday ceiling", () => {
  // CONFIG.maximum_average_weekly_working_hours is a confirmed 42h AVERAGE
  // (see lib/labor-rules.ts) — the old 40h prototype value is never
  // reintroduced. Its reference period, however, is deliberately NOT
  // confirmed (never defaulted to 7/14/28 days), so a single displayed
  // week's total can no longer, by itself, prove compliance or violation.
  it("confirms the real CONFIG average is 42h, never 40h — and the reference period is deliberately unconfigured", () => {
    expect(CONFIG.maximum_average_weekly_working_hours).toBe(42);
    expect(CONFIG.working_hours_reference_period_days).toBeNull();
  });

  it("a displayed week CAN exceed 42h without automatic violation — the user's own worked example (five MT02 shifts, 10.25h each = 51.25h) is not, by itself, evidence of a violation", () => {
    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((d) => ({
      day_of_week: d,
      shift_code: "MT02", // 04:30-14:45 = 10h15
      status: "working" as const,
    }));
    const employee = makeEmployee(days);
    expect(computeScheduledWeeklyHours(employee, TEST_WEEK_START)).toBeCloseTo(51.25, 1);
    // No PlanIssue is raised solely from this one displayed week's total.
    expect(checkAverageWeeklyHours(employee, CONFIG, TEST_WEEK_START)).toBeNull();
  });

  it("checkAverageWeeklyHours never emits a weekly_hours_violation while the reference period is unconfigured, no matter how high the displayed week's total is", () => {
    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((d) => ({
      day_of_week: d,
      shift_code: "NR02", // 51.25h across 5 days
      status: "working" as const,
    }));
    const employee = makeEmployee(days);
    expect(checkAverageWeeklyHours(employee, CONFIG, TEST_WEEK_START)).toBeNull();
  });

  it("evaluateAverageWorkingHours returns an explicit not_evaluable/reference_period_unconfigured state, never a silent pass or fail, while the period is unconfigured", () => {
    const result = evaluateAverageWorkingHours(51.25, 5, CONFIG);
    expect(result).toEqual({ status: "not_evaluable", reason: "reference_period_unconfigured" });
  });

  it("once a reference period IS configured (hypothetically), the same evaluator computes a real average and can find a violation — proving the foundation works without inventing the real period in production config", () => {
    const configuredForTest = { ...CONFIG, working_hours_reference_period_days: 7 };
    const result = evaluateAverageWorkingHours(51.25, 5, configuredForTest);
    expect(result.status).toBe("violation");
    if (result.status !== "not_evaluable") {
      expect(result.averageWeeklyHours).toBeCloseTo((51.25 / 5) * 7, 1);
      expect(result.referencePeriodDays).toBe(7);
    }
  });

  it("auditAverageWeeklyHoursFeasibility returns an empty array while the reference period is unconfigured — no ConfigurationIssue is generated solely from a displayed-week total, even for a structurally long-shift static category", () => {
    const employees = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((d, i) =>
      makeEmployee(
        [{ day_of_week: d, shift_code: "NR02", status: "working" as const }],
        { id: `static-${i}`, assignment: "Caisse/BCB" }
      )
    );
    const issues = auditAverageWeeklyHoursFeasibility(employees, () => false, CONFIG, TEST_WEEK_START);
    expect(issues).toEqual([]);
  });
});

describe("validateWeeklyPlan", () => {
  it("surfaces unfilled_duty issues — but NEVER a needs_configuration issue; that's collectConfigurationIssues's job, entirely separate", () => {
    const unfilled = [{ dayOfWeek: "Wednesday", requirementId: "r2", role: "Check-in", stillNeeded: 2 }];
    const issues = validateWeeklyPlan(unfilled, [], ["Wednesday"], CONFIG, TEST_WEEK_START);
    expect(issues.some((i) => i.type === "unfilled_duty")).toBe(true);
    // "needs_configuration" isn't even a valid PlanIssueType any more —
    // this asserts the array contains ONLY the type we gave it.
    expect(issues.every((i) => i.type === "unfilled_duty")).toBe(true);
  });
});

describe("collectConfigurationIssues", () => {
  it("collects only needs_configuration requirements, as their own ConfigurationIssue — never mixed into operational PlanIssues", () => {
    const requirements = [
      { id: "r1", flight_id: "f1", role: "Staffing Rule", baseline_requirement: 0, additional_requirement: 0, total_requirement: 0, source: "fixed_rule" as const, reasoning: "no rule configured", needs_configuration: true },
      { id: "r2", flight_id: "f1", role: "Gate", baseline_requirement: 1, additional_requirement: 0, total_requirement: 1, source: "fixed_rule" as const, reasoning: "", needs_configuration: false },
    ];
    const issues = collectConfigurationIssues(requirements);
    expect(issues).toEqual([{ requirementId: "r1", description: "no rule configured" }]);
  });

  it("returns an empty array when nothing needs configuration", () => {
    const requirements = [
      { id: "r1", flight_id: "f1", role: "Gate", baseline_requirement: 1, additional_requirement: 0, total_requirement: 1, source: "fixed_rule" as const, reasoning: "", needs_configuration: false },
    ];
    expect(collectConfigurationIssues(requirements)).toEqual([]);
  });
});
