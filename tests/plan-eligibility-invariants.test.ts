import { describe, it, expect } from "vitest";
import { EMPLOYEES, FLIGHTS, CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_START, CURRENT_WEEK_LABEL } from "../lib/seed-data";
import { buildDraftPlanBundle, planIdForWeek } from "../lib/planning/weekly-plan-service";
import { computeWeeklyStaffingRequirements } from "../lib/planning/weekly-requirements";
import { getShiftTimesAs } from "../lib/shift-templates";
import { getRequirementWindow } from "../lib/planning/requirement-window";

/**
 * Hard eligibility invariant, checked against the ACTUAL generated demo
 * plan (real ~206-employee seed data, real flights/requirements) rather
 * than a synthetic fixture — this is what caught the real bug: scoring.ts
 * previously let an employee whose shift didn't overlap a flight's
 * requirement window at all get auto-recommended and persisted as a real
 * Assignment, because the only check it ever made was "does the shift END
 * before the window ENDS" (an extension check), never whether the shift
 * and window overlapped in the first place.
 *
 * The authoritative source for "is this employee working, and on what
 * shift" is the plan's own persisted WeeklyPlanRosterEntry set (via
 * buildDraftPlanBundle's rosterEntries) — never a live re-read of
 * Employee.weekly_shifts once a plan roster exists (see
 * resolvePlanRosterEntry's and buildDayEffectivePoolFromRosterEntries's
 * doc comments in lib/planning/duty-generation.ts).
 */
function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function windowsOverlap(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  return timeToMinutes(a.start) < timeToMinutes(b.end) && timeToMinutes(b.start) < timeToMinutes(a.end);
}

describe("weekly plan eligibility invariants (generated demo plan)", () => {
  const planId = planIdForWeek(CURRENT_WEEK_START);
  const requirements = computeWeeklyStaffingRequirements(FLIGHTS, CONFIG);
  const bundle = buildDraftPlanBundle({
    planId,
    weekStart: CURRENT_WEEK_START,
    weekLabel: CURRENT_WEEK_LABEL,
    revision: 1,
    flights: FLIGHTS,
    employees: EMPLOYEES,
    config: CONFIG,
    daysOrder: DAYS_WITH_DATA,
  });

  const rosterByKey = new Map(bundle.rosterEntries.map((r) => [`${r.employee_id}|${r.day_of_week}`, r]));
  const reqsById = new Map(requirements.map((r) => [r.id, r]));
  const flightsById = new Map(FLIGHTS.map((f) => [f.id, f]));

  it("every Assignment resolves to a real, working WeeklyPlanRosterEntry for its date, never OFF and never missing", () => {
    expect(bundle.assignments.length).toBeGreaterThan(0);

    for (const a of bundle.assignments) {
      const req = reqsById.get(a.staffing_requirement_id);
      expect(req, `assignment ${a.id} references a nonexistent requirement`).toBeDefined();
      const flight = flightsById.get(req!.flight_id);
      expect(flight, `assignment ${a.id} references a nonexistent flight`).toBeDefined();

      const roster = rosterByKey.get(`${a.employee_id}|${flight!.day_of_week}`);
      // Step 1 of the eligibility invariant: a roster entry must exist.
      expect(roster, `${a.employee_id} has an Assignment on ${flight!.day_of_week} with no WeeklyPlanRosterEntry at all`).toBeDefined();
      // Step 2: it must not be OFF. OFF has no working interval, so it can
      // never contain an assignment.
      expect(roster!.status, `${a.employee_id} is OFF on ${flight!.day_of_week} (${flight!.flight_number}) but holds a real duty`).not.toBe("off");
      expect(roster!.shift_code).not.toBeNull();
    }
  });

  it("every Assignment's requirement window overlaps the employee's actual persisted shift window for that date (assignment ⊆/overlaps roster_shift_window, never disjoint)", () => {
    let checked = 0;
    const violations: string[] = [];

    for (const a of bundle.assignments) {
      checked++;
      const req = reqsById.get(a.staffing_requirement_id)!;
      const flight = flightsById.get(req.flight_id)!;
      const roster = rosterByKey.get(`${a.employee_id}|${flight.day_of_week}`)!;
      const shiftTimes = getShiftTimesAs(roster.shift_code!);
      const window = getRequirementWindow(req, flight);

      // The hard constraint: an assignment must fall within the employee's
      // actual working interval for that day -- a shift that doesn't
      // overlap the requirement window AT ALL (not "needs an extension",
      // literally a different part of the day) can never be a legitimate
      // duty. Full ⊆ containment is NOT required -- the RAM window rule
      // (getRequirementWindow) opens a full T-1h/T-1h30 lead before
      // departure as the ideal coverage start, and an employee clocking in
      // partway through that lead time to cover the window through
      // departure is real, intended shift coverage, not a violation.
      if (!windowsOverlap(window, { start: shiftTimes.shift_start, end: shiftTimes.shift_end })) {
        violations.push(
          `${a.employee_id} on ${flight.day_of_week} (${flight.flight_number}, ${req.role}): window ${window.start}-${window.end} vs shift ${shiftTimes.shift_start}-${shiftTimes.shift_end}`
        );
      }
    }

    expect(checked).toBeGreaterThan(0);
    expect(violations, violations.join("\n")).toHaveLength(0);
  });

  it("OFF days and working weekends are driven purely by each employee's actual roster, never a Saturday/Sunday assumption", () => {
    // If the display/generation logic ever hardcoded "weekend = off," every
    // employee would be off on both Saturday and Sunday simultaneously.
    // Real staggered rosters must NOT show that pattern -- both days must
    // have a real mix of working and off employees, and the mix must not
    // be uniformly worse than weekdays (which is exactly the symptom the
    // 1000-row PostgREST pagination bug produced on the read side).
    const byDay = new Map<string, { working: number; off: number }>();
    for (const day of DAYS_WITH_DATA) byDay.set(day, { working: 0, off: 0 });
    for (const entry of bundle.rosterEntries) {
      const bucket = byDay.get(entry.day_of_week)!;
      if (entry.status === "off") bucket.off++;
      else bucket.working++;
    }

    for (const day of ["Saturday", "Sunday"]) {
      const { working, off } = byDay.get(day)!;
      // Working weekends are valid and expected -- most of the workforce
      // must actually be working, not off, on both weekend days.
      expect(working, `${day}: expected most employees working, got ${working} working / ${off} off`).toBeGreaterThan(off);
    }

    // Off-day counts should be in the same rough band across all 7 days
    // (a flat 2-day-per-week stagger) -- no day should be a dramatic
    // outlier the way "every employee off" would be.
    const offCounts = DAYS_WITH_DATA.map((d) => byDay.get(d)!.off);
    const maxOff = Math.max(...offCounts);
    const minOff = Math.min(...offCounts);
    expect(maxOff).toBeLessThan(minOff * 4);
  });

  it("Assignment plan_id matches the bundle's own plan_id (no cross-revision drift)", () => {
    for (const a of bundle.assignments) {
      expect(a.plan_id).toBe(planId);
    }
    for (const r of bundle.rosterEntries) {
      expect(r.plan_id).toBe(planId);
    }
  });
});
