import { describe, it, expect } from "vitest";
import { maxConsecutiveOffCyclic, checkConsecutiveOffCyclic } from "../lib/planning/consecutive-off";
import { checkConsecutiveOff } from "../lib/planning/validation";
import { EMPLOYEES, CONFIG } from "../lib/seed-data";
import { Employee, WeeklyShiftEntry } from "../lib/types";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function statusRow(pattern: ("W" | "O")[]): { status: "working" | "off" }[] {
  return pattern.map((p) => ({ status: p === "O" ? ("off" as const) : ("working" as const) }));
}

function makeEmployee(weeklyShifts: WeeklyShiftEntry[], overrides: Partial<Employee> = {}): Employee {
  return {
    id: "emp", name: "Test Employee", skills: [], assignment: "General T1 Pool",
    shift_code: null, shift_start: null, shift_end: null, rest_before_shift_hours: null,
    weekly_hours: null, is_duty_officer: false, off_days: [], foreign_company_authorizations: [],
    active: true, weekly_shifts: weeklyShifts,
    ...overrides,
  };
}

describe("maxConsecutiveOffCyclic", () => {
  it("counts a normal 2-day OFF block as 2", () => {
    expect(maxConsecutiveOffCyclic(statusRow(["W", "W", "W", "W", "W", "O", "O"]))).toBe(2);
  });

  it("detects OFF OFF OFF within a single displayed week", () => {
    expect(maxConsecutiveOffCyclic(statusRow(["W", "W", "W", "W", "O", "O", "O"]))).toBe(3);
  });

  it("detects Sat+Sun+Mon as 3 consecutive OFF across the week boundary (wraparound), not two separate weeks", () => {
    // Saturday, Sunday OFF at the end of the week; Monday OFF at the
    // start — must be evaluated as one continuous 3-day run, not treated
    // as two independent 1-2 day runs because they're split across the
    // display array's ends.
    const pattern: ("W" | "O")[] = ["O", "W", "W", "W", "W", "O", "O"]; // Mon=O, ..., Sat=O, Sun=O
    expect(maxConsecutiveOffCyclic(statusRow(pattern))).toBe(3);
  });

  it("correctly joins Sunday+Monday into one 2-day run across the boundary, without over-counting an unrelated mid-week single OFF day", () => {
    // Mon=O, Thu=O (isolated), Sun=O — Sunday and Monday are cyclically
    // adjacent, so they form one genuine 2-day rest block; Thursday is a
    // separate, unrelated single OFF day and must not be merged into it.
    const pattern: ("W" | "O")[] = ["O", "W", "W", "O", "W", "W", "O"];
    expect(maxConsecutiveOffCyclic(statusRow(pattern))).toBe(2);
  });
});

describe("checkConsecutiveOff (validation wiring)", () => {
  it("flags a real 3-consecutive-OFF schedule for a non-fixed-cycle employee", () => {
    const employee = makeEmployee(
      DAYS.map((d, i) => ({ day_of_week: d, shift_code: i < 4 ? "MT01" : null, status: i < 4 ? "working" : "off" }))
    );
    const issue = checkConsecutiveOff(employee, CONFIG);
    expect(issue?.type).toBe("consecutive_off_violation");
  });

  it("never flags a Transit/Leaders (fixed-cycle) employee via the period-7 wraparound check — their real continuous cycle is validated against the resolved labor protection instead, and the confirmed cycle satisfies it", () => {
    // Constructed to superficially LOOK like it wraps into 3 consecutive
    // OFF under a period-7 assumption, but assignment is Transit — the
    // employee's own weekly_shifts snapshot is never wrapped; only the
    // cycle definition's true maxConsecutiveOffInCycle (2) is checked
    // against config.max_consecutive_off_days (2), so this passes.
    const employee = makeEmployee(
      DAYS.map((d, i) => ({ day_of_week: d, shift_code: i < 4 ? "JR02" : null, status: i < 4 ? "working" : "off" })),
      { assignment: "Transit" }
    );
    expect(checkConsecutiveOff(employee, CONFIG)).toBeNull();
  });
});

describe("real generated workforce — no employee exceeds the confirmed max consecutive OFF days", () => {
  it("holds for every employee in EMPLOYEES (fixed-cycle teams checked against their real continuous cycle, everyone else via the cyclic single-week check)", () => {
    const violations: string[] = [];
    for (const e of EMPLOYEES) {
      if (e.assignment === "Transit" || e.assignment === "Leaders") continue; // checked in fixed-cycle-rotation.test.ts against the true 14-day cycle
      const v = checkConsecutiveOffCyclic(e, CONFIG.max_consecutive_off_days);
      if (v) violations.push(`${e.name} (${e.assignment}): ${v.maxConsecutiveOffDays} consecutive OFF days`);
    }
    expect(violations).toEqual([]);
  });
});
