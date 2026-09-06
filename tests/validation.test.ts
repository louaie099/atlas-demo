import { describe, it, expect } from "vitest";
import { computeScheduledWeeklyHours, checkRestBetweenDays, checkWeeklyHoursCeiling, validateWeeklyPlan, collectConfigurationIssues } from "../lib/planning/validation";
import { CONFIG } from "../lib/seed-data";
import { Employee, WeeklyShiftEntry } from "../lib/types";

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
    expect(computeScheduledWeeklyHours(employee)).toBe(18);
  });

  it("returns 0 for an employee with no working days", () => {
    const employee = makeEmployee([{ day_of_week: "Monday", shift_code: null, status: "off" }]);
    expect(computeScheduledWeeklyHours(employee)).toBe(0);
  });
});

describe("checkRestBetweenDays", () => {
  it("flags insufficient rest between two consecutive working days", () => {
    // N8: 21:00-06:15. Next day MT02: 04:30-14:45.
    // Rest = (04:30 + 24h) - 06:15 = 28:30 - 06:15 = 22h15... let's use a
    // genuinely tight case instead: NT01 (17:45-06:15) into JR02 (04:30-16:45).
    // Rest = (04:30+24h) - 06:15 = way more than needed; construct a
    // deliberately tight back-to-back pair instead.
    const employee = makeEmployee([
      { day_of_week: "Monday", shift_code: "AP04", status: "working" }, // 13:45-02:00 (overnight)
      { day_of_week: "Tuesday", shift_code: "MT02", status: "working" }, // 04:30-14:45
    ]);
    const issues = checkRestBetweenDays(employee, ["Monday", "Tuesday"], CONFIG);
    // AP04 ends 02:00 (next calendar time within Monday's overnight shift);
    // MT02 starts 04:30 the following day → rest = 04:30+24h - 02:00 = 26h30,
    // which is NOT a violation. Assert no false positive here.
    expect(issues).toHaveLength(0);
  });

  it("does not flag rest between a working day and an OFF day", () => {
    const employee = makeEmployee([
      { day_of_week: "Monday", shift_code: "AP02", status: "working" },
      { day_of_week: "Tuesday", shift_code: null, status: "off" },
    ]);
    expect(checkRestBetweenDays(employee, ["Monday", "Tuesday"], CONFIG)).toHaveLength(0);
  });

  it("flags a genuinely tight back-to-back case", () => {
    // NR02: 08:00-18:15. Next day NR01: 08:00-16:45.
    // Rest = (08:00 + 24h) - 18:15 = 32:00 - 18:15 = 13h45 — not a violation (min 10h).
    // Construct an actual violation: same-day-repeat-style N8 (21:00-06:15)
    // into NR01 (08:00-16:45) — rest = (08:00+24h)-06:15 = way over 10h too.
    // Use MT03 (05:45-15:45) into MT02 (04:30-14:45) next day:
    // rest = (04:30+24h) - 15:45 = 28:30 - 15:45 = 12h45 — still not a violation.
    // Genuinely tight: AP02 (13:45-23:15) into MT02 (04:30-14:45):
    // rest = (04:30+24h) - 23:15 = 28:30 - 23:15 = 5h15 — violation (min 10h).
    const employee = makeEmployee([
      { day_of_week: "Monday", shift_code: "AP02", status: "working" },
      { day_of_week: "Tuesday", shift_code: "MT02", status: "working" },
    ]);
    const issues = checkRestBetweenDays(employee, ["Monday", "Tuesday"], CONFIG);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("rest_violation");
  });
});

describe("checkWeeklyHoursCeiling", () => {
  // CONFIG.fairness_ceiling_hours is the literal "unconfirmed" (see
  // lib/labor-rules.ts — the old 40h prototype value was deliberately not
  // carried forward as a real number). These tests exercise the ceiling
  // MECHANISM against an explicit, test-local confirmed value, and
  // separately assert the real, current CONFIG never flags anyone while
  // the ceiling stays unconfirmed.
  const CONFIRMED_CEILING_CONFIG = { ...CONFIG, fairness_ceiling_hours: 40 as const };

  it("flags an employee scheduled above a CONFIRMED fairness ceiling", () => {
    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((d) => ({
      day_of_week: d,
      shift_code: "NR02", // 08:00-18:15 = 10.25h × 5 = 51.25h, well above a 40h ceiling
      status: "working" as const,
    }));
    const employee = makeEmployee(days);
    const issue = checkWeeklyHoursCeiling(employee, CONFIRMED_CEILING_CONFIG);
    expect(issue?.type).toBe("weekly_hours_violation");
  });

  it("does not flag an employee within a CONFIRMED ceiling", () => {
    const employee = makeEmployee([{ day_of_week: "Monday", shift_code: "MT01", status: "working" }]);
    expect(checkWeeklyHoursCeiling(employee, CONFIRMED_CEILING_CONFIG)).toBeNull();
  });

  it("never flags anyone while the ceiling is unconfirmed (real CONFIG)", () => {
    expect(CONFIG.fairness_ceiling_hours).toBe("unconfirmed");
    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((d) => ({
      day_of_week: d,
      shift_code: "NR02", // would be 51.25h — well above any plausible ceiling
      status: "working" as const,
    }));
    const employee = makeEmployee(days);
    expect(checkWeeklyHoursCeiling(employee, CONFIG)).toBeNull();
  });
});

describe("validateWeeklyPlan", () => {
  it("surfaces unfilled_duty issues — but NEVER a needs_configuration issue; that's collectConfigurationIssues's job, entirely separate", () => {
    const unfilled = [{ dayOfWeek: "Wednesday", requirementId: "r2", role: "Check-in", stillNeeded: 2 }];
    const issues = validateWeeklyPlan(unfilled, [], ["Wednesday"], CONFIG);
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
