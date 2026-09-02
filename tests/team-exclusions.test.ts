import { describe, it, expect } from "vitest";
import { scoreCandidates } from "../lib/scoring";
import { CONFIG } from "../lib/seed-data";
import { Employee } from "../lib/types";

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "test-emp",
    name: "Test Employee",
    skills: ["Boarding"],
    assignment: "General T1 Pool",
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
  it("never includes a Transit-assigned employee as a candidate for a non-Transit role, even if skilled", () => {
    const transitEmployee = makeEmployee({
      id: "transit-1",
      skills: ["Arrivals", "Boarding"], // skilled for Boarding, but currently assigned to Transit
      assignment: "Transit",
    });
    const results = scoreCandidates("Boarding", { start: "13:50", end: "14:20" }, [transitEmployee], CONFIG);
    expect(results.find((r) => r.employee.id === "transit-1")).toBeUndefined();
  });

  it("Transit is an assignment, not a skill — a Find Agent query for role \"Transit\" correctly returns nobody, since no skill is named that", () => {
    // This is a direct consequence of the skill/assignment split, not a
    // gap: Transit-area work isn't one of the confirmed flight-task
    // skills (Boarding, Gate, Check-in, Arrivals), so it's never something
    // Find Agent searches candidates for. Transit-assigned employees are
    // excluded from OTHER roles (previous test) but are never themselves
    // "found" via a Transit role search.
    const transitEmployee = makeEmployee({
      id: "transit-1",
      skills: ["Arrivals"],
      assignment: "Transit",
    });
    const results = scoreCandidates("Transit", { start: "13:50", end: "14:20" }, [transitEmployee], CONFIG);
    expect(results).toHaveLength(0);
  });

  it("never includes Leaders/Duty Officers/Caisse-BCB in general candidate pools, even if skilled", () => {
    const leader = makeEmployee({ id: "leader-1", skills: ["Boarding"], assignment: "Leaders" });
    const caisse = makeEmployee({ id: "caisse-1", skills: ["Boarding"], assignment: "Caisse/BCB" });
    const results = scoreCandidates("Boarding", { start: "13:50", end: "14:20" }, [leader, caisse], CONFIG);
    expect(results).toHaveLength(0);
  });

  it("an employee whose skill overlaps with an assignment name (e.g. holding 'Boarding' while assigned to Profiling) remains a normal Boarding candidate — assignment alone doesn't exclude unless it's Transit or fixed-planning", () => {
    const employee = makeEmployee({
      id: "flexible-1",
      skills: ["Boarding"],
      assignment: "Profiling",
    });
    const results = scoreCandidates("Boarding", { start: "13:45", end: "14:00" }, [employee], CONFIG);
    expect(results.find((r) => r.employee.id === "flexible-1")?.status).toBe("recommended");
  });

  it("an employee currently assigned to a foreign company is NOT blanket-excluded from RAM roles they're skilled for, when no overlapping commitment is passed in", () => {
    const employee = makeEmployee({
      id: "foreign-assigned-1",
      skills: ["Boarding"],
      assignment: "Emirates",
    });
    const results = scoreCandidates("Boarding", { start: "13:45", end: "14:00" }, [employee], CONFIG);
    expect(results.find((r) => r.employee.id === "foreign-assigned-1")?.status).toBe("recommended");
  });
});
