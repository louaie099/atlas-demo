import { describe, it, expect } from "vitest";
import { EMPLOYEES, DAYS_WITH_DATA } from "../lib/seed-data";
import { TEAMS } from "../lib/teams";

describe("weekly_shifts — day-by-day variation", () => {
  it("every employee has exactly one weekly_shifts entry per day with data", () => {
    for (const e of EMPLOYEES) {
      expect(e.weekly_shifts).toHaveLength(DAYS_WITH_DATA.length);
      expect(e.weekly_shifts.map((s) => s.day_of_week)).toEqual(DAYS_WITH_DATA);
    }
  });

  it("at least one employee has genuinely different shift codes across different working days (not one code applied to the whole week)", () => {
    const varied = EMPLOYEES.find((e) => {
      const workingCodes = e.weekly_shifts.filter((s) => s.status === "working").map((s) => s.shift_code);
      return new Set(workingCodes).size > 1;
    });
    expect(varied).toBeDefined();
  });

  it("at least one employee has an OFF day in the middle of an otherwise-working week", () => {
    const withMidweekOff = EMPLOYEES.find(
      (e) => e.weekly_shifts.some((s) => s.status === "off") && e.weekly_shifts.some((s) => s.status === "working")
    );
    expect(withMidweekOff).toBeDefined();
  });

  it("an OFF day always has a null shift_code", () => {
    for (const e of EMPLOYEES) {
      for (const entry of e.weekly_shifts) {
        if (entry.status === "off") expect(entry.shift_code).toBeNull();
      }
    }
  });
});

describe("Foreign-Company Pool is not a team", () => {
  it("does not appear in the TEAMS list", () => {
    expect(TEAMS as readonly string[]).not.toContain("Foreign-Company Pool");
  });

  it("no employee has 'Foreign-Company Pool' as their default_team", () => {
    expect(EMPLOYEES.every((e) => e.default_team !== "Foreign-Company Pool")).toBe(true);
  });

  it("every employee's default_team is a real team from TEAMS", () => {
    expect(EMPLOYEES.every((e) => (TEAMS as readonly string[]).includes(e.default_team))).toBe(true);
  });

  it("employees can hold foreign-company authorizations while keeping a normal RAM team", () => {
    const authorized = EMPLOYEES.filter((e) => e.foreign_company_authorizations.length > 0);
    expect(authorized.length).toBeGreaterThan(0);
    for (const e of authorized) {
      expect(e.default_team).not.toBe("Foreign-Company Pool");
      expect(TEAMS as readonly string[]).toContain(e.default_team);
    }
  });
});
