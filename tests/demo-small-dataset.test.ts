import { describe, it, expect } from "vitest";
import {
  SMALL_DEMO_CONFIG,
  SMALL_DEMO_EMPLOYEES,
  SMALL_DEMO_FLIGHTS,
  SMALL_DEMO_DAYS_WITH_DATA,
  SMALL_DEMO_WEEK_START,
  SMALL_DEMO_WEEK_LABEL,
} from "../lib/demo-small/dataset";
import { computeWeeklyStaffingRequirements } from "../lib/planning/weekly-requirements";
import { buildDraftPlanBundle, planIdForWeek } from "../lib/planning/weekly-plan-service";
import { getShiftTimesAs } from "../lib/shift-templates";

/**
 * Locks in the shape and real-engine behavior of the small, separate
 * UI/manual-testing dataset (lib/demo-small/*) requested 2026-10-04:
 * ~20-25 agents, 8-12 flights/day, a NORMALLY FEASIBLE but TIGHT plan with
 * genuine, bounded bottlenecks — never engineered to guarantee 100%
 * coverage, and never touching the main (large) seeded dataset.
 */
describe("small demo dataset — shape", () => {
  it("has between 20 and 25 employees", () => {
    expect(SMALL_DEMO_EMPLOYEES.length).toBeGreaterThanOrEqual(20);
    expect(SMALL_DEMO_EMPLOYEES.length).toBeLessThanOrEqual(25);
  });

  it("has every employee active, with a real shift, and a unique id", () => {
    const ids = new Set<string>();
    for (const e of SMALL_DEMO_EMPLOYEES) {
      expect(e.active).toBe(true);
      expect(e.shift_code).not.toBeNull();
      expect(e.shift_start).not.toBeNull();
      expect(e.shift_end).not.toBeNull();
      expect(ids.has(e.id)).toBe(false);
      ids.add(e.id);
    }
  });

  it("has roughly 8-12 flights on every day of the week", () => {
    const byDay: Record<string, number> = {};
    for (const f of SMALL_DEMO_FLIGHTS) byDay[f.day_of_week] = (byDay[f.day_of_week] ?? 0) + 1;
    for (const day of SMALL_DEMO_DAYS_WITH_DATA) {
      expect(byDay[day]).toBeGreaterThanOrEqual(7);
      expect(byDay[day]).toBeLessThanOrEqual(12);
    }
  });

  it("preserves real qualification differences — more than one distinct skill set across the roster", () => {
    const distinctSkillSets = new Set(SMALL_DEMO_EMPLOYEES.map((e) => [...e.skills].sort().join(",")));
    expect(distinctSkillSets.size).toBeGreaterThanOrEqual(6);
  });

  it("preserves real shift diversity — more than one distinct shift code across the roster", () => {
    const distinctShiftCodes = new Set(SMALL_DEMO_EMPLOYEES.map((e) => e.shift_code));
    expect(distinctShiftCodes.size).toBeGreaterThanOrEqual(4);
  });

  it("includes the configured foreign-carrier path (Qatar Airways) without it dominating the roster", () => {
    const qatarEmployees = SMALL_DEMO_EMPLOYEES.filter((e) => e.assignment === "Qatar Airways");
    expect(qatarEmployees.length).toBeGreaterThan(0);
    expect(qatarEmployees.length).toBeLessThan(SMALL_DEMO_EMPLOYEES.length / 3);
    for (const e of qatarEmployees) expect(e.foreign_company_authorizations).toContain("Qatar Airways");
  });

  it("names are stable, hand-authored identifiers (never index-generated), so the same people are recognizable across Monthly Planning and Live Operations", () => {
    const expectedIds = [
      "small-yasmine-rafiq",
      "small-fadwa-benjelloun",
      "small-widad-senhaji",
      "small-nawal-fassi",
      "small-nabil-cherkaoui",
      "small-aziz-lahlou",
      "small-mounir-skalli",
    ];
    const ids = new Set(SMALL_DEMO_EMPLOYEES.map((e) => e.id));
    for (const id of expectedIds) expect(ids.has(id)).toBe(true);
  });
});

describe("small demo dataset — real-engine generation (never a second seed-only implementation)", () => {
  const requirements = computeWeeklyStaffingRequirements(SMALL_DEMO_FLIGHTS, SMALL_DEMO_CONFIG);

  it("computes a non-trivial set of real staffing requirements", () => {
    expect(requirements.length).toBeGreaterThan(50);
    const totalPositions = requirements.reduce((sum, r) => sum + r.total_requirement, 0);
    expect(totalPositions).toBeGreaterThan(100);
  });

  it("generates a draft plan through the real pipeline without throwing (e.g. no RotationInfeasibleError)", () => {
    const planId = planIdForWeek(SMALL_DEMO_WEEK_START);
    expect(() =>
      buildDraftPlanBundle({
        planId,
        weekStart: SMALL_DEMO_WEEK_START,
        weekLabel: SMALL_DEMO_WEEK_LABEL,
        revision: 1,
        flights: SMALL_DEMO_FLIGHTS,
        employees: SMALL_DEMO_EMPLOYEES,
        config: SMALL_DEMO_CONFIG,
        daysOrder: SMALL_DEMO_DAYS_WITH_DATA,
      })
    ).not.toThrow();
  });

  it("produces a plan that is feasible but genuinely tight — most requirements covered, but not manufactured to 100%", () => {
    const planId = planIdForWeek(SMALL_DEMO_WEEK_START);
    const bundle = buildDraftPlanBundle({
      planId,
      weekStart: SMALL_DEMO_WEEK_START,
      weekLabel: SMALL_DEMO_WEEK_LABEL,
      revision: 1,
      flights: SMALL_DEMO_FLIGHTS,
      employees: SMALL_DEMO_EMPLOYEES,
      config: SMALL_DEMO_CONFIG,
      daysOrder: SMALL_DEMO_DAYS_WITH_DATA,
    });

    const totalPositions = requirements.reduce((sum, r) => sum + r.total_requirement, 0);
    const coverageRatio = bundle.assignments.length / totalPositions;

    // Feasible: the large majority of a normal week's demand is covered.
    expect(coverageRatio).toBeGreaterThan(0.75);
    // Tight: this is NOT a 100%-coverage dataset — real, honest gaps exist.
    // (Never assert === 1, and never adjust the dataset just to clear this
    // bound — a passing dataset that always hits 100% would mean the
    // "meaningful bottleneck" requirement silently regressed.)
    expect(coverageRatio).toBeLessThan(1);

    // At least one genuinely unfilled requirement is reported as a real
    // Plan Issue (not silently dropped) — the dataset's bottlenecks must
    // be visible, not just numerically present.
    const unfilledDutyIssues = bundle.plan.issues.filter((i) => i.type === "unfilled_duty");
    expect(unfilledDutyIssues.length).toBeGreaterThan(0);
  });

  it("never auto-assigns an employee whose shift doesn't fully contain the duty window (2026-10-04 containment rule, patch 0084)", () => {
    const planId = planIdForWeek(SMALL_DEMO_WEEK_START);
    const bundle = buildDraftPlanBundle({
      planId,
      weekStart: SMALL_DEMO_WEEK_START,
      weekLabel: SMALL_DEMO_WEEK_LABEL,
      revision: 1,
      flights: SMALL_DEMO_FLIGHTS,
      employees: SMALL_DEMO_EMPLOYEES,
      config: SMALL_DEMO_CONFIG,
      daysOrder: SMALL_DEMO_DAYS_WITH_DATA,
    });

    const employeesById = new Map(SMALL_DEMO_EMPLOYEES.map((e) => [e.id, e]));
    const rosterByEmployeeDay = new Map(bundle.rosterEntries.map((r) => [`${r.employee_id}:${r.day_of_week}`, r]));
    const requirementsById = new Map(requirements.map((r) => [r.id, r]));

    function timeToMinutes(t: string): number {
      const [h, m] = t.split(":").map(Number);
      return h * 60 + m;
    }

    let checked = 0;
    for (const a of bundle.assignments) {
      const req = requirementsById.get(a.staffing_requirement_id);
      if (!req || req.source === "company_config") continue; // company_config eligibility is authorization-based, not a shift-window containment question
      const flight = SMALL_DEMO_FLIGHTS.find((f) => f.id === req.flight_id)!;
      const roster = rosterByEmployeeDay.get(`${a.employee_id}:${flight.day_of_week}`);
      if (!roster || roster.status !== "working" || !roster.shift_code) continue;
      const employee = employeesById.get(a.employee_id)!;
      void employee;

      // Reconstruct the real shift window for this roster day's code at this flight's real date.
      const { shift_start, shift_end } = getShiftTimesAs(roster.shift_code, flight.flight_date);

      // The assignment's own duty window isn't directly on Assignment —
      // approximate via the requirement's standard fixed-rule window
      // (departure - 60/90 min to departure), which is exactly what
      // duty-generation.ts uses for Gate/Boarding/Profiling/Mesure.
      const isDreamliner = flight.aircraft.includes("787");
      const openBefore = isDreamliner ? 90 : 60;
      const windowStart = timeToMinutes(flight.scheduled_departure) - openBefore;
      const windowEnd = timeToMinutes(flight.scheduled_departure);

      expect(timeToMinutes(shift_start)).toBeLessThanOrEqual(windowStart);
      expect(timeToMinutes(shift_end)).toBeGreaterThanOrEqual(windowEnd);
      checked++;
    }

    // Sanity: this test should actually have exercised real assignments.
    expect(checked).toBeGreaterThan(50);
  });
});
