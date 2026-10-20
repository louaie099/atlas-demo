import { describe, it, expect } from "vitest";
import { computeMonthlyHoursForEmployee, MonthlyHoursWeekInput } from "../lib/planning/monthly-hours";
import { DEFAULT_BREAK_POLICY, BreakPolicy } from "../lib/break-policy";
import { WeeklyPlanRosterEntry } from "../lib/types";
import { weeksOverlappingMonth, flightDateFor } from "../lib/flight-date";

// Post-regime (>= 2026-09-20) shift codes: MT03 = 05:45-14:45 (9h),
// AP01 = 13:45-22:45 (9h), NT01 = 17:45-06:30 overnight (~12.75h).

function entry(employeeId: string, dayOfWeek: string, status: "working" | "off", shiftCode: string | null): WeeklyPlanRosterEntry {
  return { id: `${employeeId}-${dayOfWeek}`, plan_id: "irrelevant", employee_id: employeeId, day_of_week: dayOfWeek, status, shift_code: shiftCode };
}

describe("lib/planning/monthly-hours — calendar-month paid-hours aggregation", () => {
  const MONTH_START = "2026-10-01"; // October 2026, 31 days

  it("full-month coverage: every overlapping week has a plan with every day covered -> status evaluable, correct totals", () => {
    const weekStarts = weeksOverlappingMonth(MONTH_START);
    const weeks: MonthlyHoursWeekInput[] = weekStarts.map((weekStart) => {
      const entries: WeeklyPlanRosterEntry[] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day) =>
        entry("emp-1", day, "working", "MT03")
      );
      return { weekStart, planExists: true, entries };
    });
    const result = computeMonthlyHoursForEmployee("emp-1", MONTH_START, weeks);
    expect(result.status).toBe("evaluable");
    expect(result.calendarDaysInMonth).toBe(31);
    expect(result.calendarDaysCovered).toBe(31);
    expect(result.scheduledSpanTotal).toBe(31 * 9);
    expect(result.paidHoursTotal).toBe(31 * 9); // disabled break policy -> paid == span
    expect(result.provisional).toBe(true); // DEFAULT_BREAK_POLICY is unconfirmed_prototype
  });

  it("an OFF day is a covered day contributing zero hours -- not a gap", () => {
    const weekStarts = weeksOverlappingMonth(MONTH_START);
    const weeks: MonthlyHoursWeekInput[] = weekStarts.map((weekStart) => ({
      weekStart,
      planExists: true,
      entries: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day) =>
        entry("emp-1", day, "off", null)
      ),
    }));
    const result = computeMonthlyHoursForEmployee("emp-1", MONTH_START, weeks);
    expect(result.status).toBe("evaluable"); // fully covered, just all OFF
    expect(result.calendarDaysCovered).toBe(31);
    expect(result.paidHoursTotal).toBe(0);
  });

  it("a genuinely unplanned week (no weekly_plans row) reports partial_coverage, never an assumed zero for its days", () => {
    const weekStarts = weeksOverlappingMonth(MONTH_START);
    const weeks: MonthlyHoursWeekInput[] = weekStarts.map((weekStart, i) => {
      if (i === 1) return { weekStart, planExists: false, entries: [] }; // a real gap -- week never even generated
      return {
        weekStart,
        planExists: true,
        entries: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day) =>
          entry("emp-1", day, "working", "MT03")
        ),
      };
    });
    const result = computeMonthlyHoursForEmployee("emp-1", MONTH_START, weeks);
    expect(result.status).toBe("partial_coverage");
    expect(result.calendarDaysCovered).toBeLessThan(31);
  });

  it("no plan at all anywhere in the month -> no_data, never evaluable or partial_coverage", () => {
    const weekStarts = weeksOverlappingMonth(MONTH_START);
    const weeks: MonthlyHoursWeekInput[] = weekStarts.map((weekStart) => ({ weekStart, planExists: false, entries: [] }));
    const result = computeMonthlyHoursForEmployee("emp-1", MONTH_START, weeks);
    expect(result.status).toBe("no_data");
    expect(result.calendarDaysCovered).toBe(0);
    expect(result.paidHoursTotal).toBe(0);
  });

  it("a shift is attributed ENTIRELY to its scheduled START date -- an overnight shift starting on the last day of the month is counted in THIS month, never double-counted into the next", () => {
    const weekStarts = weeksOverlappingMonth(MONTH_START);
    // Find the week whose Saturday is Oct 31, 2026 and give that employee an
    // overnight NT01 shift starting Saturday (Oct 31) -- its sortie lands on
    // Nov 1, but the hours must still count entirely toward October.
    const weeks: MonthlyHoursWeekInput[] = weekStarts.map((weekStart) => {
      const saturdayDate = flightDateFor(weekStart, "Saturday");
      const entries: WeeklyPlanRosterEntry[] =
        saturdayDate === "2026-10-31" ? [entry("emp-1", "Saturday", "working", "NT01")] : [];
      return { weekStart, planExists: true, entries };
    });
    const october = computeMonthlyHoursForEmployee("emp-1", "2026-10-01", weeks);
    expect(october.calendarDaysCovered).toBe(1);
    expect(october.scheduledSpanTotal).toBeGreaterThan(12); // the full overnight span, not truncated at midnight
    expect(october.paidHoursTotal).toBe(october.scheduledSpanTotal);

    // The SAME week data, aggregated for November, must not also count this
    // shift's hours a second time -- its date (Oct 31) falls outside
    // November's range, so November sees zero covered days from this week.
    const november = computeMonthlyHoursForEmployee("emp-1", "2026-11-01", weeks);
    expect(november.calendarDaysCovered).toBe(0);
  });

  it("filters to the requested employee only -- another employee's entries in the same week never leak into this total", () => {
    const weekStarts = weeksOverlappingMonth(MONTH_START);
    const weeks: MonthlyHoursWeekInput[] = weekStarts.map((weekStart) => ({
      weekStart,
      planExists: true,
      entries: [entry("emp-1", "Monday", "working", "MT03"), entry("emp-2", "Monday", "working", "AP01")],
    }));
    const result = computeMonthlyHoursForEmployee("emp-1", MONTH_START, weeks);
    expect(result.paidHoursTotal).toBe(weeksOverlappingMonth(MONTH_START).filter((w) => {
      const d = flightDateFor(w, "Monday");
      return d >= "2026-10-01" && d < "2026-11-01";
    }).length * 9);
  });

  it("a confirmed break policy deducts correctly and is reported non-provisional", () => {
    const policy: BreakPolicy = { enabled: true, source: "confirmed_management_policy", unpaidBreakMinutesPerShift: 30, minimumShiftHoursForBreak: null };
    const weeks: MonthlyHoursWeekInput[] = [
      { weekStart: "2026-09-28", planExists: true, entries: [entry("emp-1", "Thursday", "working", "MT03")] }, // Oct 1, 2026 is a Thursday
    ];
    const result = computeMonthlyHoursForEmployee("emp-1", MONTH_START, weeks, policy);
    expect(result.scheduledSpanTotal).toBe(9);
    expect(result.paidHoursTotal).toBe(8.5);
    expect(result.provisional).toBe(false);
  });
});
