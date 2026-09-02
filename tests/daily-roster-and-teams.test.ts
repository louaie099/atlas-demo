import { describe, it, expect } from "vitest";
import { EMPLOYEES, DAYS_WITH_DATA } from "../lib/seed-data";
import { TEAMS } from "../lib/teams";
import { CONFIGURED_COMPANIES } from "../lib/company-config";

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

  it("no employee has 'Foreign-Company Pool' as their assignment", () => {
    expect(EMPLOYEES.every((e) => e.assignment !== "Foreign-Company Pool")).toBe(true);
  });
});

describe("assignment is either a real internal team or a configured foreign company", () => {
  it("every employee's assignment is one or the other — never an arbitrary string", () => {
    for (const e of EMPLOYEES) {
      const isTeam = (TEAMS as readonly string[]).includes(e.assignment);
      const isCompany = CONFIGURED_COMPANIES.includes(e.assignment);
      expect(isTeam || isCompany).toBe(true);
    }
  });

  it("at least one employee is genuinely ASSIGNED to a foreign company (not just authorized)", () => {
    const assignedToForeignCompany = EMPLOYEES.filter((e) => CONFIGURED_COMPANIES.includes(e.assignment));
    expect(assignedToForeignCompany.length).toBeGreaterThan(0);
  });

  it("employees can hold foreign-company authorizations while currently assigned elsewhere — authorization is not the same as assignment", () => {
    const authorizedButNotAssignedThere = EMPLOYEES.filter(
      (e) =>
        e.foreign_company_authorizations.length > 0 &&
        !e.foreign_company_authorizations.includes(e.assignment)
    );
    expect(authorizedButNotAssignedThere.length).toBeGreaterThan(0);
  });
});
