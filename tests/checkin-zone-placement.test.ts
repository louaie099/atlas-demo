import { describe, it, expect } from "vitest";
import { subtractBusyWindows, isEligibleForDefaultCheckinPlacement } from "../lib/planning/checkin-zone-placement";
import { Employee } from "../lib/types";

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "emp", name: "Test", skills: ["Check-in"], assignment: "General T1 Pool",
    shift_code: "AP01", rest_before_shift_hours: 15,
    weekly_hours: 10, is_duty_officer: false, off_days: [], foreign_company_authorizations: [],
    active: true, weekly_shifts: [{ day_of_week: "Wednesday", shift_code: "AP01", status: "working" }],
    ...overrides,
  } as Employee;
}

describe("subtractBusyWindows", () => {
  it("splits a shift around a single middle commitment into two free intervals, never overlapping it", () => {
    const free = subtractBusyWindows({ start: "05:45", end: "14:45" }, [{ start: "08:00", end: "09:00" }]);
    expect(free).toEqual([
      { start: "05:45", end: "08:00" },
      { start: "09:00", end: "14:45" },
    ]);
  });

  it("drops a residual sliver shorter than the minimum placement duration", () => {
    const free = subtractBusyWindows({ start: "05:45", end: "06:00" }, []); // exactly 15 min -> below the 30 min minimum
    expect(free).toEqual([]);
  });

  it("returns the whole shift untouched when there are no busy windows", () => {
    const free = subtractBusyWindows({ start: "05:45", end: "14:45" }, []);
    expect(free).toEqual([{ start: "05:45", end: "14:45" }]);
  });

  it("returns nothing when a busy window fully covers the shift", () => {
    const free = subtractBusyWindows({ start: "05:45", end: "14:45" }, [{ start: "00:00", end: "23:59" }]);
    expect(free).toEqual([]);
  });
});

/**
 * 2026-09-23 architecture refactor: this module used to also export
 * `computeDefaultCheckinZonePlacement`, which produced discrete
 * ZoneCoverageDuty rows -- the root cause of the "Required 4 / Assigned 75"
 * bug once persisted (see checkin-zone-placement.ts's own module doc
 * comment). That function is gone; `isEligibleForDefaultCheckinPlacement`
 * (the one true eligibility rule it used to apply internally) is now
 * exported directly and tested here, and is reused unchanged by
 * lib/planning/checkin-capacity-timeline.ts (see
 * tests/checkin-capacity-timeline.test.ts for the atomic-interval
 * Required/Available computation this eligibility rule now feeds).
 */
describe("isEligibleForDefaultCheckinPlacement", () => {
  it("is eligible: an active, Check-in-qualified General T1 Pool employee", () => {
    expect(isEligibleForDefaultCheckinPlacement(makeEmployee({}))).toBe(true);
  });

  it("never eligible: a Transit-assigned employee, even if nominally Check-in-qualified", () => {
    expect(isEligibleForDefaultCheckinPlacement(makeEmployee({ assignment: "Transit", skills: ["Check-in", "Transit"] }))).toBe(false);
  });

  it("never eligible: a Profiling/Mesure-assigned employee -- that is their own team's real commitment", () => {
    expect(isEligibleForDefaultCheckinPlacement(makeEmployee({ assignment: "Profiling" }))).toBe(false);
  });

  it("never eligible: a fixed-planning-team employee (Leaders/Duty Officers/Caisse-BCB)", () => {
    expect(isEligibleForDefaultCheckinPlacement(makeEmployee({ assignment: "Leaders" }))).toBe(false);
  });

  it("IS eligible: a foreign-company-assigned employee, now that redeployment defaults to true for every configured company (2026-09-22)", () => {
    expect(isEligibleForDefaultCheckinPlacement(makeEmployee({ assignment: "Gulf Air" }))).toBe(true);
  });

  it("never eligible: an employee without the Check-in skill", () => {
    expect(isEligibleForDefaultCheckinPlacement(makeEmployee({ skills: ["Boarding"] }))).toBe(false);
  });

  it("never eligible: an inactive employee", () => {
    expect(isEligibleForDefaultCheckinPlacement(makeEmployee({ active: false }))).toBe(false);
  });

  it("never eligible: a Duty Officer", () => {
    expect(isEligibleForDefaultCheckinPlacement(makeEmployee({ is_duty_officer: true }))).toBe(false);
  });
});
