import { describe, it, expect } from "vitest";
import { EMPLOYEES, FLIGHTS, CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_START } from "../lib/seed-data";
import { CONFIGURED_COMPANIES } from "../lib/company-config";
import { generateDraftWeeklyPlan } from "../lib/planning/generate-draft-plan";
import { JR_NT_OFF_OFF_CYCLE, cycleStepAt } from "../lib/fixed-cycle-rotation";
import { generateFixedCycleEmployees } from "../lib/employee-generator";
import { usesFixedCycleRotation } from "../lib/teams";

/**
 * Regression coverage for the roster-generation correction: (1) a normal
 * (non-fixed-cycle, non-foreign-company) employee must always have exactly
 * the confirmed 2 OFF days — no silent 3-4-OFF exception, implicit or
 * legacy; (2) Transit/Leaders/Duty Officers must come from the real
 * continuous JR->NT->OFF->OFF cycle, never a flat/AP01 fallback; (3) a
 * foreign-company employee's STATIC seed-time baseline (still built by
 * applyForeignCompanyRoster, retained as durable/legacy data — see
 * specialized-team-generation.ts) must never silently balloon into extra
 * OFF days via the old rest-fallback-to-OFF anti-pattern.
 *
 * NOTE: what a foreign-company rest conflict actually PRODUCES in the
 * final generated PLAN changed under the specialized-team-roster
 * milestone — generate-draft-plan.ts now derives foreign-company rosters
 * fresh each run (specialized-team-generation.ts), tries every rested/
 * authorized employee in the company's own group and every compatible
 * catalog code before accepting a shortfall, and never falls back to a
 * rest-ignoring shift; a genuine shortfall surfaces as a BLOCKING
 * configuration conflict, never a persisted rest_violation Plan Warning
 * (see the last describe block below).
 */
describe("roster generation — normal employees always have exactly 2 OFF days", () => {
  it("every non-fixed-cycle, non-foreign-company employee has exactly 2 OFF days in the generated week", () => {
    // usesFixedCycleRotation, not a hardcoded ["Transit","Leaders"] list --
    // Duty Officers now shares the same confirmed JR/NT/OFF/OFF cycle (see
    // the specialized-team-roster milestone), and a period-4 cycle
    // legitimately shows 1-3 OFF cells in a 7-day display window
    // depending on phase, never exactly 2 by construction -- excluded
    // here for the same reason Transit/Leaders always were.
    const normal = EMPLOYEES.filter((e) => !usesFixedCycleRotation(e.assignment) && !CONFIGURED_COMPANIES.includes(e.assignment));
    expect(normal.length).toBeGreaterThan(0);
    for (const e of normal) {
      const offCount = e.weekly_shifts.filter((s) => s.status === "off").length;
      expect(offCount, `${e.id} (${e.assignment}) should have exactly 2 OFF days, has ${offCount}`).toBe(2);
    }
  });
});

describe("roster generation — Transit and Leaders follow the real fixed JR->NT->OFF->OFF cycle", () => {
  it("never uses AP01 (or any flat generic shift) as a Transit/Leaders working day", () => {
    const fixedCycleEmployees = EMPLOYEES.filter((e) => ["Transit", "Leaders"].includes(e.assignment));
    expect(fixedCycleEmployees.length).toBeGreaterThan(0);
    for (const e of fixedCycleEmployees) {
      for (const shift of e.weekly_shifts) {
        if (shift.status === "working") {
          expect(["JR02", "NT01"]).toContain(shift.shift_code);
        }
      }
    }
  });

  it("a real Transit employee's 14-day sequence matches the continuous cycle exactly, staggered by offset", () => {
    const fc = generateFixedCycleEmployees(0);
    const transitSeed = fc.find((f) => f.employee.assignment === "Transit")!;
    const sequence = Array.from({ length: 14 }, (_, i) => {
      const step = cycleStepAt(JR_NT_OFF_OFF_CYCLE, i, transitSeed.cycleOffset);
      return "off" in step ? "OFF" : step.code;
    });
    // The cycle must repeat every 4 days with exactly 2 OFF days per cycle.
    expect(sequence.slice(0, 4)).toEqual(sequence.slice(4, 8));
    expect(sequence.slice(0, 4)).toEqual(sequence.slice(8, 12));
    const offInFirstCycle = sequence.slice(0, 4).filter((s) => s === "OFF").length;
    expect(offInFirstCycle).toBe(2);
  });
});

describe("roster generation — no automatic extra-OFF fallback for foreign-company rest conflicts", () => {
  it("a foreign-company employee whose rest-aware shift selection fails still gets a real working shift (coverage-only fallback), not a silently invented OFF day", () => {
    const foreignEmployees = EMPLOYEES.filter((e) => CONFIGURED_COMPANIES.includes(e.assignment));
    for (const e of foreignEmployees) {
      const offCount = e.weekly_shifts.filter((s) => s.status === "off").length;
      // Foreign-company employees follow demand-derived rotations, which
      // may legitimately differ from 2 — but must never silently balloon
      // due to the retired rest-fallback-to-OFF anti-pattern. For the
      // current seed data, every configured foreign-company employee's
      // real off-day count is exactly 2 once the anti-pattern is removed.
      expect(offCount).toBe(2);
    }
  });

  it("a foreign-company coverage shortfall NEVER surfaces as a persisted rest_violation Plan Warning any more — it is either resolved by generation (another rested employee/compatible code) or reported as a real, honest BLOCKING configuration conflict", () => {
    const plan = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, "Test Week", CURRENT_WEEK_START);
    const restViolations = plan.issues.filter((i) => i.type === "rest_violation");
    expect(restViolations).toHaveLength(0);
  });
});
