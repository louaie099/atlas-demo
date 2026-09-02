import { describe, it, expect } from "vitest";
import { scoreCandidates } from "../lib/scoring";
import { CONFIG } from "../lib/seed-data";
import { Employee } from "../lib/types";

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "emp-1",
    name: "Test Employee",
    skills: ["Boarding"],
    assignment: "Emirates",
    shift_code: "NR02",
    shift_start: "08:00",
    shift_end: "18:00",
    rest_before_shift_hours: 12,
    weekly_hours: 20,
    is_duty_officer: false,
    off_days: [],
    foreign_company_authorizations: ["Emirates"],
    weekly_shifts: [],
    ...overrides,
  };
}

// Matches the exact example given: shift 08:00-18:00, foreign commitment
// 10:30-15:00. The employee should be excluded for anything overlapping
// 10:30-15:00, but remain eligible before 10:30 and after 15:00.
describe("scoreCandidates — date/time-aware foreign-commitment exclusion", () => {
  it("excludes the employee for a requirement window that overlaps their protected commitment", () => {
    const employee = makeEmployee({});
    const occupiedWindows = { "emp-1": [{ start: "10:30", end: "15:00" }] };

    const results = scoreCandidates(
      "Boarding",
      { start: "12:00", end: "12:30" }, // fully inside the protected window
      [employee],
      CONFIG,
      occupiedWindows
    );
    expect(results.find((r) => r.employee.id === "emp-1")).toBeUndefined();
  });

  it("excludes the employee for a requirement window that PARTIALLY overlaps the protected commitment", () => {
    const employee = makeEmployee({});
    const occupiedWindows = { "emp-1": [{ start: "10:30", end: "15:00" }] };

    const results = scoreCandidates(
      "Boarding",
      { start: "09:45", end: "10:45" }, // overlaps the first 15 minutes of the commitment
      [employee],
      CONFIG,
      occupiedWindows
    );
    expect(results.find((r) => r.employee.id === "emp-1")).toBeUndefined();
  });

  it("keeps the employee eligible for a requirement window entirely BEFORE the protected commitment", () => {
    const employee = makeEmployee({});
    const occupiedWindows = { "emp-1": [{ start: "10:30", end: "15:00" }] };

    const results = scoreCandidates(
      "Boarding",
      { start: "08:30", end: "09:00" },
      [employee],
      CONFIG,
      occupiedWindows
    );
    expect(results.find((r) => r.employee.id === "emp-1")?.status).toBe("recommended");
  });

  it("keeps the employee eligible for a requirement window entirely AFTER the protected commitment", () => {
    const employee = makeEmployee({});
    const occupiedWindows = { "emp-1": [{ start: "10:30", end: "15:00" }] };

    const results = scoreCandidates(
      "Boarding",
      { start: "15:30", end: "16:00" },
      [employee],
      CONFIG,
      occupiedWindows
    );
    expect(results.find((r) => r.employee.id === "emp-1")?.status).toBe("recommended");
  });

  it("does not exclude the employee at all when no occupiedWindows entry is provided for them (persistent assignment alone never excludes)", () => {
    const employee = makeEmployee({});
    const results = scoreCandidates("Boarding", { start: "12:00", end: "12:30" }, [employee], CONFIG, {});
    expect(results.find((r) => r.employee.id === "emp-1")?.status).toBe("recommended");
  });

  it("excludes correctly when the employee has MULTIPLE protected windows the same day and the requirement overlaps any one of them", () => {
    const employee = makeEmployee({});
    const occupiedWindows = {
      "emp-1": [
        { start: "07:00", end: "09:00" },
        { start: "10:30", end: "15:00" },
      ],
    };
    const results = scoreCandidates("Boarding", { start: "08:00", end: "08:30" }, [employee], CONFIG, occupiedWindows);
    expect(results.find((r) => r.employee.id === "emp-1")).toBeUndefined();
  });
});
