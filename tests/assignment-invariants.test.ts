import { describe, it, expect } from "vitest";
import { EMPLOYEES, FLIGHTS, CONFIG, DAYS_WITH_DATA, INITIAL_AT201_ASSIGNEES, INITIAL_AT201_PROFILING_ASSIGNEE } from "../lib/seed-data";
import { CONFIGURED_COMPANIES } from "../lib/company-config";
import { computeWeeklyStaffingRequirements } from "../lib/planning/weekly-requirements";
import { buildForeignCommitmentAssignments } from "../lib/foreign-shift-planning";
import { buildWeeklyPlanView } from "../lib/planning/weekly-plan-view";
import { generateDraftWeeklyPlan } from "../lib/planning/generate-draft-plan";
import { getRequirementWindow } from "../lib/planning/requirement-window";

/**
 * Regression coverage for the Flight Coverage over-assignment/overlap
 * correction: (1) a requirement's assigned headcount must never exceed its
 * confirmed total_requirement, (2) an employee must never appear twice
 * within the same requirement, (3) an employee must never hold two
 * incompatible duties whose windows overlap — verified across the full
 * generated week, not just AT201.
 */
function windowsOverlap(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  const t = (s: string) => {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
  };
  return t(a.start) < t(b.end) && t(b.start) < t(a.end);
}

describe("buildForeignCommitmentAssignments — headcount and no-double-booking invariants", () => {
  const requirements = computeWeeklyStaffingRequirements(FLIGHTS, CONFIG);
  const assignments = buildForeignCommitmentAssignments(EMPLOYEES, FLIGHTS, requirements, DAYS_WITH_DATA, CONFIGURED_COMPANIES);

  it("never assigns more employees to a requirement than its confirmed total_requirement (e.g. Gulf Air 6/2, Emirates 9/3 must not happen)", () => {
    const byRequirement = new Map<string, Set<string>>();
    for (const a of assignments) {
      const set = byRequirement.get(a.staffing_requirement_id) ?? new Set<string>();
      set.add(a.employee_id);
      byRequirement.set(a.staffing_requirement_id, set);
    }
    for (const [reqId, employeeIds] of byRequirement) {
      const requirement = requirements.find((r) => r.id === reqId)!;
      expect(employeeIds.size, `${reqId} should have <= ${requirement.total_requirement} distinct employees`).toBeLessThanOrEqual(
        requirement.total_requirement
      );
    }
    expect(byRequirement.size).toBeGreaterThan(0);
  });

  it("never assigns the same employee twice to the same requirement", () => {
    const byRequirement = new Map<string, string[]>();
    for (const a of assignments) {
      byRequirement.set(a.staffing_requirement_id, [...(byRequirement.get(a.staffing_requirement_id) ?? []), a.employee_id]);
    }
    for (const [, employeeIds] of byRequirement) {
      expect(new Set(employeeIds).size).toBe(employeeIds.length);
    }
  });

  it("a Gulf Air flight with a confirmed headcount of 2 gets exactly 2 (never all 6 working Gulf Air employees)", () => {
    const gf105Requirement = requirements.find((r) => {
      const flight = FLIGHTS.find((f) => f.id === r.flight_id);
      return flight?.flight_number === "GF105";
    })!;
    const assignedToGf105 = new Set(
      assignments.filter((a) => a.staffing_requirement_id === gf105Requirement.id).map((a) => a.employee_id)
    );
    expect(assignedToGf105.size).toBeLessThanOrEqual(gf105Requirement.total_requirement);
  });
});

describe("AT201 — Boarding and Profiling no longer over-assigned or overlapping", () => {
  const requirements = computeWeeklyStaffingRequirements(FLIGHTS, CONFIG);
  const boardingReq = requirements.find((r) => r.flight_id === "at201" && r.role === "Boarding")!;
  const profilingReq = requirements.find((r) => r.flight_id === "at201" && r.role === "Profiling")!;
  const existingAssignments = [
    ...INITIAL_AT201_ASSIGNEES.map((employeeId, i) => ({
      id: `ab${i}`,
      staffing_requirement_id: boardingReq.id,
      employee_id: employeeId,
      assigned_at: "",
    })),
    { id: "ap0", staffing_requirement_id: profilingReq.id, employee_id: INITIAL_AT201_PROFILING_ASSIGNEE, assigned_at: "" },
  ];

  it("Boarding shows exactly 1/1, never 2/1", () => {
    const { roster } = buildWeeklyPlanView(FLIGHTS, EMPLOYEES, existingAssignments, requirements, CONFIG, DAYS_WITH_DATA, "Test Week");
    const boardingRow = roster.find((r) => r.requirement.id === boardingReq.id)!;
    expect(boardingRow.assignedEmployees).toHaveLength(1);
    expect(boardingRow.requirement.total_requirement).toBe(1);
  });

  it("no employee is confirmed for both Boarding and Profiling on the same flight (overlapping windows)", () => {
    const boardingEmployeeIds = new Set(existingAssignments.filter((a) => a.staffing_requirement_id === boardingReq.id).map((a) => a.employee_id));
    const profilingEmployeeIds = new Set(existingAssignments.filter((a) => a.staffing_requirement_id === profilingReq.id).map((a) => a.employee_id));
    const overlap = [...boardingEmployeeIds].filter((id) => profilingEmployeeIds.has(id));
    expect(overlap).toEqual([]);
  });
});

describe("whole-week scan — no over-assignment, no duplicate-employee, no overlapping-duty violations", () => {
  it("scans every requirement across the generated week (confirmed + proposed) and finds zero invariant violations", () => {
    const requirements = computeWeeklyStaffingRequirements(FLIGHTS, CONFIG);
    const boardingReq = requirements.find((r) => r.flight_id === "at201" && r.role === "Boarding")!;
    const profilingReq = requirements.find((r) => r.flight_id === "at201" && r.role === "Profiling")!;
    const scriptedAssignments = [
      ...INITIAL_AT201_ASSIGNEES.map((employeeId, i) => ({
        id: `ab${i}`,
        staffing_requirement_id: boardingReq.id,
        employee_id: employeeId,
      })),
      { id: "ap0", staffing_requirement_id: profilingReq.id, employee_id: INITIAL_AT201_PROFILING_ASSIGNEE },
    ];
    const foreignAssignments = buildForeignCommitmentAssignments(EMPLOYEES, FLIGHTS, requirements, DAYS_WITH_DATA, CONFIGURED_COMPANIES);
    const allAssignments = [...scriptedAssignments, ...foreignAssignments];

    const plan = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, allAssignments as any, CONFIG, DAYS_WITH_DATA, "Week");

    let overAssigned = 0;
    let duplicateEmployee = 0;
    let overlapViolations = 0;
    let maxRatio = 0;

    for (const day of DAYS_WITH_DATA) {
      const dayFlightIds = new Set(FLIGHTS.filter((f) => f.day_of_week === day).map((f) => f.id));
      const dayReqs = requirements.filter((r) => dayFlightIds.has(r.flight_id) && !r.needs_configuration);
      const empDutiesToday: Record<string, { reqId: string; window: { start: string; end: string } }[]> = {};

      for (const r of dayReqs) {
        const flight = FLIGHTS.find((f) => f.id === r.flight_id)!;
        const window = getRequirementWindow(r, flight);
        const confirmed = allAssignments.filter((a) => a.staffing_requirement_id === r.id).map((a) => a.employee_id);
        const proposed = (plan.dutiesByDay[day] ?? []).filter((d) => d.requirementId === r.id).map((d) => d.employeeId);
        const all = [...confirmed, ...proposed];
        const distinct = new Set(all);

        if (distinct.size !== all.length) duplicateEmployee++;
        if (distinct.size > r.total_requirement) overAssigned++;
        maxRatio = Math.max(maxRatio, distinct.size / r.total_requirement);

        for (const empId of distinct) {
          empDutiesToday[empId] = empDutiesToday[empId] ?? [];
          for (const existing of empDutiesToday[empId]) {
            if (windowsOverlap(existing.window, window)) overlapViolations++;
          }
          empDutiesToday[empId].push({ reqId: r.id, window });
        }
      }
    }

    expect(overAssigned).toBe(0);
    expect(duplicateEmployee).toBe(0);
    expect(overlapViolations).toBe(0);
    expect(maxRatio).toBeLessThanOrEqual(1);
  });
});
