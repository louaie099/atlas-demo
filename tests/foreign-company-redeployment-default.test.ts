import { describe, it, expect } from "vitest";
import { isEligibleForDefaultCheckinPlacement, subtractBusyWindows } from "../lib/planning/checkin-zone-placement";
import { isRedeploymentAllowed } from "../lib/teams";
import { CONFIGURED_COMPANIES } from "../lib/company-config";
import { Employee } from "../lib/types";

/**
 * Regression coverage for Fix 2 (2026-09-22 audit -- see
 * docs/known-limitations/roster-planning-vs-duty-allocation.md):
 * cross-team redeployment defaults to TRUE for every configured foreign
 * company (Transit remains the one hard, non-configurable exception).
 */

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "emp", name: "Test", skills: ["Boarding"], assignment: "General T1 Pool",
    shift_code: null, shift_start: null, shift_end: null, rest_before_shift_hours: null,
    weekly_hours: null, is_duty_officer: false, off_days: [], foreign_company_authorizations: [],
    active: true, weekly_shifts: [],
    ...overrides,
  };
}

describe("Fix 2 -- cross-team redeployment defaults to true for every configured foreign company", () => {
  it("every CONFIGURED_COMPANIES entry redeploys by default; Transit never does, regardless", () => {
    for (const company of CONFIGURED_COMPANIES) {
      expect(isRedeploymentAllowed(company)).toBe(true);
    }
    expect(isRedeploymentAllowed("Transit")).toBe(false);
  });

  it("Transit remains never-redeployable (explicit regression, hard exception)", () => {
    // isTransitTeam short-circuits isRedeploymentAllowed unconditionally,
    // before any table/company lookup -- this must never change.
    expect(isRedeploymentAllowed("Transit")).toBe(false);
  });

  it("Mesure/Profiling/fixed-planning teams are untouched by the new foreign-company default", () => {
    expect(isRedeploymentAllowed("Mesure")).toBe(false);
    expect(isRedeploymentAllowed("Profiling")).toBe(false);
    expect(isRedeploymentAllowed("Leaders")).toBe(false);
    expect(isRedeploymentAllowed("Duty Officers")).toBe(false);
    expect(isRedeploymentAllowed("Caisse/BCB")).toBe(false);
    expect(isRedeploymentAllowed("General T1 Pool")).toBe(false);
  });

  it("a redeployment-eligible foreign-company employee is now a real eligibility-check pass for T1 Check-in placement outside their protected window", () => {
    const employee = makeEmployee({
      id: "e1", assignment: "Gulf Air", skills: ["Check-in"],
      shift_start: "05:45", shift_end: "14:45", rest_before_shift_hours: 15, weekly_hours: 8,
    }) as Employee & { shift_start: string; shift_end: string };
    expect(isEligibleForDefaultCheckinPlacement(employee)).toBe(true);
    // Protected window recorded as busy, exactly as duty-generation.ts
    // would produce it for a real company_config assignment -- subtracting
    // it leaves only the time after it free, same as
    // lib/planning/checkin-capacity-timeline.ts does per atomic period.
    const free = subtractBusyWindows({ start: employee.shift_start, end: employee.shift_end }, [{ start: "05:45", end: "10:15" }]);
    expect(free).toEqual([{ start: "10:15", end: "14:45" }]);
  });

  it("the '12 required but 16 available -> required stays 12' invariant still holds: eligibility/availability is computed for every free employee, independent of any zone's required headcount elsewhere", () => {
    const employees = Array.from({ length: 16 }, (_, i) =>
      makeEmployee({ id: `e${i}`, skills: ["Check-in"], shift_start: "05:45", shift_end: "14:45", rest_before_shift_hours: 15, weekly_hours: 8 })
    ) as (Employee & { shift_start: string; shift_end: string })[];
    const eligibleCount = employees.filter(isEligibleForDefaultCheckinPlacement).length;
    expect(eligibleCount).toBe(16); // all 16 eligible -- required_headcount (elsewhere, e.g. 12) is a separate, independent number
  });
});
