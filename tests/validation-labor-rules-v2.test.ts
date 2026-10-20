import { describe, it, expect } from "vitest";
import { checkWeeklyPaidHours, checkMaxContinuousShiftDuration, checkMaxConsecutiveNightShifts, validateWeeklyPlan } from "../lib/planning/validation";
import { CONFIG } from "../lib/seed-data";
import { Employee, WeeklyShiftEntry, Config } from "../lib/types";
import { BreakPolicy } from "../lib/break-policy";
import { DAYS_ORDER } from "../lib/flight-date";

// A Monday on/after the 2026-10-05 shift-time regime, matching this
// milestone's other LABOR RULES v2 tests (MT03 = 05:45-14:45 = 9h,
// NT01 = 17:45-06:30 overnight = 12.75h).
const WEEK_START = "2026-10-19";

function makeEmployee(weeklyShifts: WeeklyShiftEntry[], overrides: Partial<Employee> = {}): Employee {
  return {
    id: "emp", name: "Test Employee", skills: ["Boarding"], assignment: "General T1 Pool",
    shift_code: null, shift_start: null, shift_end: null, rest_before_shift_hours: null,
    weekly_hours: null, is_duty_officer: false, off_days: [], foreign_company_authorizations: [],
    active: true, weekly_shifts: weeklyShifts,
    ...overrides,
  };
}

function fullWeek(shiftCode: string | null, workingDays: string[] = DAYS_ORDER): WeeklyShiftEntry[] {
  return DAYS_ORDER.map((day) => ({
    day_of_week: day,
    status: workingDays.includes(day) ? "working" : "off",
    shift_code: workingDays.includes(day) ? shiftCode : null,
  }));
}

describe("checkWeeklyPaidHours (LABOR RULES v2)", () => {
  it("emits nothing when both min/max are unconfigured (null)", () => {
    const employee = makeEmployee(fullWeek("MT03"));
    expect(checkWeeklyPaidHours(employee, CONFIG, WEEK_START)).toEqual([]);
  });

  it("flags a maximum violation using PAID hours (not scheduled span) when a break policy is configured", () => {
    const employee = makeEmployee(fullWeek("MT03", ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"])); // 5 work days * 9h = 45h span
    const breakPolicy: BreakPolicy = { enabled: true, source: "confirmed_management_policy", unpaidBreakMinutesPerShift: 30, minimumShiftHoursForBreak: null };
    const config: Config = { ...CONFIG, maximum_weekly_paid_hours: 40, break_policy: breakPolicy };
    const issues = checkWeeklyPaidHours(employee, config, WEEK_START);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("weekly_paid_hours_violation");
    expect(issues[0].description).toContain("42.5h"); // 45h span - 5*0.5h break = 42.5h paid
    expect(issues[0].description).not.toContain("provisional"); // confirmed break policy
  });

  it("flags a minimum violation and labels the figure provisional when the break policy is unconfirmed", () => {
    const employee = makeEmployee(fullWeek("MT03", ["Monday", "Tuesday"])); // 2 * 9h = 18h
    const config: Config = { ...CONFIG, minimum_weekly_paid_hours: 20 };
    const issues = checkWeeklyPaidHours(employee, config, WEEK_START);
    expect(issues).toHaveLength(1);
    expect(issues[0].description).toContain("18h paid");
    expect(issues[0].description).toContain("provisional");
  });

  it("never flags a week that is within both bounds", () => {
    const employee = makeEmployee(fullWeek("MT03", ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"])); // 45h
    const config: Config = { ...CONFIG, minimum_weekly_paid_hours: 20, maximum_weekly_paid_hours: 50 };
    expect(checkWeeklyPaidHours(employee, config, WEEK_START)).toEqual([]);
  });
});

describe("checkMaxContinuousShiftDuration (LABOR RULES v2)", () => {
  it("emits nothing when unconfigured", () => {
    const employee = makeEmployee(fullWeek("NT01"));
    expect(checkMaxContinuousShiftDuration(employee, CONFIG, WEEK_START)).toEqual([]);
  });

  it("flags every working day whose shift exceeds the configured ceiling, using the scheduled SPAN", () => {
    const employee = makeEmployee(fullWeek("NT01", ["Monday", "Wednesday"])); // ~12.75h each
    const config: Config = { ...CONFIG, max_continuous_shift_hours: 10 };
    const issues = checkMaxContinuousShiftDuration(employee, config, WEEK_START);
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.dayOfWeek)).toEqual(["Monday", "Wednesday"]);
    expect(issues[0].type).toBe("max_continuous_shift_duration_violation");
  });

  it("never flags a shift within the configured ceiling", () => {
    const employee = makeEmployee(fullWeek("MT03")); // 9h
    const config: Config = { ...CONFIG, max_continuous_shift_hours: 10 };
    expect(checkMaxContinuousShiftDuration(employee, config, WEEK_START)).toEqual([]);
  });
});

describe("checkMaxConsecutiveNightShifts (LABOR RULES v2)", () => {
  it("emits nothing when unconfigured", () => {
    const employee = makeEmployee(fullWeek("NT01"));
    expect(checkMaxConsecutiveNightShifts(employee, DAYS_ORDER, CONFIG, WEEK_START)).toEqual([]);
  });

  it("flags only once the streak exceeds the cap, not every night shift in the run", () => {
    const employee = makeEmployee(fullWeek("NT01", ["Monday", "Tuesday", "Wednesday", "Thursday"]));
    const config: Config = { ...CONFIG, max_consecutive_night_shifts: 2 };
    const issues = checkMaxConsecutiveNightShifts(employee, DAYS_ORDER, config, WEEK_START);
    // Streak: Mon=1, Tue=2 (at cap, not flagged), Wed=3 (flagged), Thu=4 (flagged)
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.dayOfWeek)).toEqual(["Wednesday", "Thursday"]);
  });

  it("a daytime shift breaks the night-shift streak", () => {
    const shifts = fullWeek(null, []);
    shifts[0] = { day_of_week: "Monday", status: "working", shift_code: "NT01" };
    shifts[1] = { day_of_week: "Tuesday", status: "working", shift_code: "NT01" };
    shifts[2] = { day_of_week: "Wednesday", status: "working", shift_code: "MT03" }; // breaks the run
    shifts[3] = { day_of_week: "Thursday", status: "working", shift_code: "NT01" };
    const employee = makeEmployee(shifts);
    const config: Config = { ...CONFIG, max_consecutive_night_shifts: 1 };
    const issues = checkMaxConsecutiveNightShifts(employee, DAYS_ORDER, config, WEEK_START);
    // Mon=1 (at cap), Tue=2 (flagged), Wed breaks it, Thu=1 (at cap, not flagged)
    expect(issues).toHaveLength(1);
    expect(issues[0].dayOfWeek).toBe("Tuesday");
  });

  it("an OFF day also breaks the night-shift streak", () => {
    const employee = makeEmployee(fullWeek("NT01", ["Monday", "Tuesday", "Thursday", "Friday"])); // Wed is OFF
    const config: Config = { ...CONFIG, max_consecutive_night_shifts: 1 };
    const issues = checkMaxConsecutiveNightShifts(employee, DAYS_ORDER, config, WEEK_START);
    expect(issues.map((i) => i.dayOfWeek)).toEqual(["Tuesday", "Friday"]);
  });
});

describe("validateWeeklyPlan wiring — LABOR RULES v2 checks run for every employee when configured", () => {
  it("surfaces all three new issue types when their rules are configured and violated", () => {
    const employee = makeEmployee(fullWeek("NT01"));
    const config: Config = { ...CONFIG, maximum_weekly_paid_hours: 1, max_continuous_shift_hours: 1, max_consecutive_night_shifts: 1 };
    const issues = validateWeeklyPlan([], [employee], DAYS_ORDER, config, WEEK_START);
    expect(issues.some((i) => i.type === "weekly_paid_hours_violation")).toBe(true);
    expect(issues.some((i) => i.type === "max_continuous_shift_duration_violation")).toBe(true);
    expect(issues.some((i) => i.type === "max_consecutive_night_shifts_violation")).toBe(true);
  });

  it("stays silent on all three when unconfigured — never a guessed ceiling", () => {
    const employee = makeEmployee(fullWeek("NT01"));
    const issues = validateWeeklyPlan([], [employee], DAYS_ORDER, CONFIG, WEEK_START);
    expect(issues.some((i) => i.type === "weekly_paid_hours_violation")).toBe(false);
    expect(issues.some((i) => i.type === "max_continuous_shift_duration_violation")).toBe(false);
    expect(issues.some((i) => i.type === "max_consecutive_night_shifts_violation")).toBe(false);
  });
});
