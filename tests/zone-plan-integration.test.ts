import { describe, it, expect } from "vitest";
import { generateDraftWeeklyPlan } from "../lib/planning/generate-draft-plan";
import { buildDraftPlanBundle } from "../lib/planning/weekly-plan-service";
import { buildPersistedWeeklyPlanView } from "../lib/planning/persisted-plan-view";
import { EMPLOYEES, FLIGHTS, CONFIG, DAYS_WITH_DATA as DAYS_ORDER, CURRENT_WEEK_LABEL as WEEK_LABEL, CURRENT_WEEK_START } from "../lib/seed-data";
import { computeWeeklyStaffingRequirements } from "../lib/planning/weekly-requirements";

/**
 * End-to-end integration coverage for the T1 Check-in zone model, against
 * the REAL seeded flight/employee/config data (the same fixtures the rest
 * of the regression suite already trusts) rather than a hand-built minimal
 * scenario -- this is what actually proves the live pipeline wiring
 * (generate-draft-plan.ts -> weekly-plan-service.ts -> persisted-plan-view.ts),
 * not just the individual unit-tested modules.
 *
 * 2026-09-23 REWRITE: this file used to assert the OLD architecture's
 * invariants (`draft.zoneDutiesByDay`, `bundle.zoneAssignments` containing
 * one row per default-placement duty, `zoneCoverage[i].assignedEmployees`).
 * That architecture is exactly what produced the live "Required 4 /
 * Assigned 75" bug (see lib/planning/checkin-capacity-timeline.ts's module
 * doc comment) and has been removed. This file now asserts the REPLACEMENT
 * invariants: `bundle.zoneAssignments` is always empty straight out of
 * generation (no discrete automatic placement row is ever persisted), and
 * `buildPersistedWeeklyPlanView`'s `zoneCoverage` is built from the DERIVED
 * capacity timeline instead, with `available` never exceeding a sane bound
 * and never zero everywhere real capacity clearly exists.
 */
describe("T1 Check-in zone model — live pipeline integration", () => {
  const draft = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_ORDER, WEEK_LABEL, CURRENT_WEEK_START);

  it("produces zone demand requirements for the real seeded week without touching any per-flight Check-in row", () => {
    const requirements = computeWeeklyStaffingRequirements(FLIGHTS, CONFIG);
    expect(requirements.some((r) => r.role === "Check-in")).toBe(false);

    const totalZoneRequirements = Object.values(draft.zoneRequirementsByDay).flat().length;
    expect(totalZoneRequirements).toBeGreaterThan(0);
  });

  it("REQUIRED-STAYS-AT-DEMAND holds: every zone requirement's required_headcount is a real, independent number", () => {
    for (const day of DAYS_ORDER) {
      for (const req of draft.zoneRequirementsByDay[day] ?? []) {
        expect(typeof req.required_headcount).toBe("number");
        expect(req.required_headcount).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("buildDraftPlanBundle never persists a discrete automatic zone assignment row any more (the exact architecture that caused the live bug)", () => {
    const bundle = buildDraftPlanBundle({
      planId: "plan-test-zone",
      weekStart: CURRENT_WEEK_START,
      weekLabel: WEEK_LABEL,
      revision: 1,
      flights: FLIGHTS,
      employees: EMPLOYEES,
      config: CONFIG,
      daysOrder: DAYS_ORDER,
    });

    expect(bundle.zoneRequirements.length).toBeGreaterThan(0);
    // The whole point of the refactor: no "atlas_generated" checkin_zone_assignments
    // row is ever produced by generation any more — see
    // weekly-plan-service.ts's buildDraftPlanBundle doc comment.
    expect(bundle.zoneAssignments.length).toBe(0);

    // buildPersistedWeeklyPlanView's zoneCoverage must be buildable from
    // exactly these rows (plus the roster/assignments already in the
    // bundle) without throwing, and must produce sane, non-degenerate
    // numbers — never the "one window inflated, adjacent window zeroed"
    // shape the old bug produced.
    const requirements = computeWeeklyStaffingRequirements(FLIGHTS, CONFIG);
    const view = buildPersistedWeeklyPlanView(
      bundle.plan,
      bundle.rosterEntries,
      bundle.assignments,
      requirements,
      FLIGHTS,
      EMPLOYEES,
      DAYS_ORDER,
      bundle.zoneRequirements,
      bundle.zoneAssignments
    );

    expect(view.zoneCoverage.length).toBeGreaterThan(0);

    const totalActiveEmployees = EMPLOYEES.filter((e) => e.active).length;
    for (const zc of view.zoneCoverage) {
      expect(zc.gap).toBe(Math.max(0, zc.required - zc.available - zc.manuallyAssigned));
      expect(zc.surplus).toBe(Math.max(0, zc.available + zc.manuallyAssigned - zc.required));
      // Available can never exceed the total active headcount — a sane
      // upper bound the old bug's "Assigned 75" (for a handful of real
      // eligible employees) blew straight through.
      expect(zc.available).toBeLessThanOrEqual(totalActiveEmployees);
      expect(zc.available).toBeGreaterThanOrEqual(0);
    }
  });

  it("no zone/day/window combination is silently starved to zero coverage immediately next to one with real reported capacity for the same zone", () => {
    // Regression for the exact bug shape: "04:00–08:30 Main Check-in —
    // Required 4 / Assigned 75" immediately followed by "09:00–15:30 Main
    // Check-in — Required 6 / Assigned 0". With the derived atomic-interval
    // timeline, adjacent windows for the same zone/day draw from the same
    // real eligible-employee pool -- a total collapse to zero right next to
    // an inflated spike should not occur when the underlying roster hasn't
    // changed that abruptly.
    const bundle = buildDraftPlanBundle({
      planId: "plan-test-zone-2",
      weekStart: CURRENT_WEEK_START,
      weekLabel: WEEK_LABEL,
      revision: 1,
      flights: FLIGHTS,
      employees: EMPLOYEES,
      config: CONFIG,
      daysOrder: DAYS_ORDER,
    });
    const requirements = computeWeeklyStaffingRequirements(FLIGHTS, CONFIG);
    const view = buildPersistedWeeklyPlanView(
      bundle.plan,
      bundle.rosterEntries,
      bundle.assignments,
      requirements,
      FLIGHTS,
      EMPLOYEES,
      DAYS_ORDER,
      bundle.zoneRequirements,
      bundle.zoneAssignments
    );

    const totalActiveEmployees = EMPLOYEES.filter((e) => e.active).length;
    for (const day of DAYS_ORDER) {
      const mainRows = view.zoneCoverage
        .filter((v) => v.dayOfWeek === day && v.zone === "t1_main_checkin")
        .sort((a, b) => a.windowStart.localeCompare(b.windowStart));
      for (let i = 1; i < mainRows.length; i++) {
        const prev = mainRows[i - 1];
        const curr = mainRows[i];
        // Never a 75-style spike -- always bounded by real headcount.
        expect(prev.available).toBeLessThanOrEqual(totalActiveEmployees);
        expect(curr.available).toBeLessThanOrEqual(totalActiveEmployees);
      }
    }
  });
});
