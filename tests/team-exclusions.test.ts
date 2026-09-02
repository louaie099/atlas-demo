import { describe, it, expect } from "vitest";
import { scoreCandidates } from "../lib/scoring";
import { CONFIG } from "../lib/seed-data";
import { Employee } from "../lib/types";

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "test-emp",
    name: "Test Employee",
    roles: ["Boarding"],
    default_team: "General T1 Pool",
    shift_code: "MT01",
    shift_start: "06:00",
    shift_end: "14:00",
    rest_before_shift_hours: 12,
    weekly_hours: 20,
    is_duty_officer: false,
    off_days: [],
    foreign_company_authorizations: [],
    weekly_shifts: [],
    ...overrides,
  };
}

describe("scoreCandidates — team-based structural exclusions", () => {
  it("never includes a Transit-team employee as a candidate for a non-Transit role, even if qualified", () => {
    const transitEmployee = makeEmployee({
      id: "transit-1",
      roles: ["Transit", "Boarding"], // qualified for Boarding, but team is Transit
      default_team: "Transit",
    });
    const results = scoreCandidates("Boarding", "14:20", [transitEmployee], CONFIG);
    expect(results.find((r) => r.employee.id === "transit-1")).toBeUndefined();
  });

  it("includes a Transit-team employee as a candidate when the role IS Transit", () => {
    const transitEmployee = makeEmployee({
      id: "transit-1",
      roles: ["Transit"],
      default_team: "Transit",
    });
    const results = scoreCandidates("Transit", "14:20", [transitEmployee], CONFIG);
    expect(results.find((r) => r.employee.id === "transit-1")).toBeDefined();
  });

  it("never includes Leaders/Duty Officers/Caisse-BCB in general candidate pools, even if qualified", () => {
    const leader = makeEmployee({ id: "leader-1", roles: ["Boarding", "Leader"], default_team: "Leaders" });
    const caisse = makeEmployee({ id: "caisse-1", roles: ["Boarding", "Caisse/BCB"], default_team: "Caisse/BCB" });
    const results = scoreCandidates("Boarding", "14:20", [leader, caisse], CONFIG);
    expect(results).toHaveLength(0);
  });

  it("a General T1 Pool employee with a Transit qualification (but not Transit team) remains a normal Boarding candidate", () => {
    // Mirrors Nadia Ziani: holds Transit qualification, but her team is General T1 Pool.
    const employee = makeEmployee({
      id: "flexible-1",
      roles: ["Boarding", "Transit"],
      default_team: "General T1 Pool",
    });
    const results = scoreCandidates("Boarding", "14:00", [employee], CONFIG);
    expect(results.find((r) => r.employee.id === "flexible-1")?.status).toBe("recommended");
  });
});
