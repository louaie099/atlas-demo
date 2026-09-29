import { describe, it, expect } from "vitest";
import { resolveDefaultLaborRules, DEFAULT_LABOR_RULES } from "../lib/labor-rules";
import { CONFIG, EMPLOYEES } from "../lib/seed-data";
import { scoreCandidates } from "../lib/scoring";
import { checkRestBetweenDays } from "../lib/planning/validation";

/**
 * These are the confirmed workforce-protection rules — the single source
 * every generator/validator must resolve against (see
 * lib/planning/consecutive-off.ts, lib/planning/validation.ts,
 * lib/rotation-feasibility.ts, lib/employee-generator.ts) rather than
 * re-declaring the number independently. This test asserts the RESOLVED
 * values and their confirmed-status metadata, not the internal shape of
 * DEFAULT_LABOR_RULES, so it still protects against a regression even if
 * the rule-set representation changes.
 */
describe("resolved default labor rules — confirmed management policy values", () => {
  const resolved = resolveDefaultLaborRules();

  it("normalWeeklyOffDays is confirmed at 2", () => {
    expect(resolved.normalWeeklyOffDays).toBe(2);
    expect(resolved.normalWeeklyOffDaysSource).toBe("confirmed_management_policy");
  });

  it("renfortWeeklyOffDays is confirmed at 1 — never read by automatic generation", () => {
    expect(resolved.renfortWeeklyOffDays).toBe(1);
    expect(resolved.renfortWeeklyOffDaysSource).toBe("confirmed_management_policy");
  });

  it("maxConsecutiveOffDays is confirmed at 2", () => {
    expect(resolved.maxConsecutiveOffDays).toBe(2);
    expect(resolved.maxConsecutiveOffDaysSource).toBe("confirmed_management_policy");
  });

  it("minimumRestHours is confirmed at 15h — the old 10h unconfirmed_prototype placeholder is gone", () => {
    expect(resolved.minimumRestHours).toBe(15);
    expect(resolved.minimumRestHoursSource).toBe("confirmed_management_policy");
  });

  it("maximumAverageWeeklyWorkingHours is confirmed at 42h — the old 40h ceiling is never reintroduced, and it's no longer 'unconfirmed'", () => {
    expect(resolved.maximumAverageWeeklyWorkingHours).toBe(42);
    expect(resolved.maximumAverageWeeklyWorkingHours).not.toBe(40);
    expect(resolved.maximumAverageWeeklyWorkingHoursSource).toBe("confirmed_management_policy");
  });

  it("workingHoursReferencePeriodDays is NOT confirmed — 42h is a confirmed average, but the period it averages over is deliberately unconfigured (never defaulted to 7/14/28 days)", () => {
    expect(resolved.workingHoursReferencePeriodDays).toBeNull();
    expect(resolved.workingHoursReferencePeriodDaysSource).toBe("unconfirmed_prototype");
  });

  it("workingHoursObligationHours is NOT confirmed — the principle (schedule to obligation, not just demand) is confirmed, but the real target/shape is not, and must never default to the 42h ceiling", () => {
    expect(resolved.workingHoursObligationHours).toBeNull();
    expect(resolved.workingHoursObligationHoursSource).toBe("unconfirmed_prototype");
    expect(resolved.workingHoursObligationHours).not.toBe(resolved.maximumAverageWeeklyWorkingHours);
  });

  it("DEFAULT_LABOR_RULES has exactly one (default/unscoped) rule set", () => {
    expect(DEFAULT_LABOR_RULES.length).toBe(1);
    expect(DEFAULT_LABOR_RULES[0].scope).toEqual({});
  });
});

describe("Config (lib/seed-data.ts) — threads the resolved labor rules through the planning pipeline", () => {
  it("CONFIG.normal_weekly_off_days / max_consecutive_off_days / renfort_weekly_off_days mirror the resolved labor rules exactly", () => {
    const resolved = resolveDefaultLaborRules();
    expect(CONFIG.normal_weekly_off_days).toBe(resolved.normalWeeklyOffDays);
    expect(CONFIG.max_consecutive_off_days).toBe(resolved.maxConsecutiveOffDays);
    expect(CONFIG.renfort_weekly_off_days).toBe(resolved.renfortWeeklyOffDays);
  });

  it("CONFIG.minimum_rest_hours / maximum_average_weekly_working_hours / working_hours_reference_period_days mirror the resolved labor rules exactly — never a hardcoded 15/42 of CONFIG's own, and never a defaulted reference period", () => {
    const resolved = resolveDefaultLaborRules();
    expect(CONFIG.minimum_rest_hours).toBe(resolved.minimumRestHours);
    expect(CONFIG.maximum_average_weekly_working_hours).toBe(resolved.maximumAverageWeeklyWorkingHours);
    expect(CONFIG.working_hours_reference_period_days).toBe(resolved.workingHoursReferencePeriodDays);
    expect(CONFIG.working_hours_reference_period_days).toBeNull();
  });

  it("CONFIG.working_hours_obligation_hours mirrors the resolved labor rules exactly — never defaulted to the 42h ceiling", () => {
    const resolved = resolveDefaultLaborRules();
    expect(CONFIG.working_hours_obligation_hours).toBe(resolved.workingHoursObligationHours);
    expect(CONFIG.working_hours_obligation_hours).toBeNull();
  });

  it("CONFIG.max_consecutive_work_days mirrors the resolved labor rules exactly, honestly labeled unconfirmed_prototype — not an independently confirmed rule (2026-09-29 correction)", () => {
    const resolved = resolveDefaultLaborRules();
    expect(CONFIG.max_consecutive_work_days).toBe(resolved.maxConsecutiveWorkDays);
    expect(resolved.maxConsecutiveWorkDays).toBe(5);
    expect(resolved.maxConsecutiveWorkDaysSource).toBe("unconfirmed_prototype");
  });

  it("Config.hard_weekly_hours_cap no longer exists at all (2026-09-29 follow-up audit) — a hidden Monday-Sunday 42h hard ceiling was removed, not relabeled, since maximum_average_weekly_working_hours is a confirmed AVERAGE over an unconfirmed reference period, never a per-week cap", () => {
    expect(CONFIG).not.toHaveProperty("hard_weekly_hours_cap");
    expect(resolveDefaultLaborRules()).not.toHaveProperty("hardWeeklyHoursCap");
  });

  it("normalWeeklyWorkDays / normalOffDaysConsecutive are confirmed and distinct from maxConsecutiveWorkDays (2026-09-29 correction, points 2 and 4)", () => {
    const resolved = resolveDefaultLaborRules();
    expect(resolved.normalWeeklyWorkDays).toBe(5);
    expect(resolved.normalWeeklyWorkDaysSource).toBe("confirmed_management_policy");
    expect(resolved.normalOffDaysConsecutive).toBe(true);
    expect(resolved.normalOffDaysConsecutiveSource).toBe("confirmed_management_policy");
    expect(CONFIG.normal_weekly_work_days).toBe(resolved.normalWeeklyWorkDays);
    expect(CONFIG.normal_off_days_consecutive).toBe(resolved.normalOffDaysConsecutive);
  });

  it("CONFIG.operational_buffer_minutes mirrors the resolved labor rules exactly — representable only, never invented", () => {
    const resolved = resolveDefaultLaborRules();
    expect(CONFIG.operational_buffer_minutes).toBe(resolved.operationalBufferMinutes);
    expect(resolved.operationalBufferMinutes).toBeNull();
    expect(resolved.operationalBufferMinutesSource).toBe("unconfirmed_prototype");
  });
});

/**
 * PLANNER CONSUMES CHANGED RULE VALUES (Planning Rules milestone). The
 * whole point of resolving Config from labor-rules.ts rather than hardcoding
 * 15/42/etc. inline is that a changed value actually changes what the
 * engine does — these tests prove that end-to-end through two real
 * consumers (scoreCandidates' eligibility gate and checkRestBetweenDays'
 * validation), not just that the number round-trips through Config.
 */
describe("changing minimum rest changes eligibility and validation, not just the stored number", () => {
  it("scoreCandidates: raising minimum_rest_hours above a candidate's real derived rest flips them from recommended to flagged, and lowering it below another candidate's rest flips them the other way", () => {
    // Hicham Bouzid's real MT01 shift derives exactly 15h rest — recommended
    // under the confirmed 15h floor, at the boundary. Rania Toumi's real
    // MT02 shift derives 13.75h — flagged under that same floor (see
    // tests/scoring.test.ts). Neither fact changes; only the config does.
    const stricter = { ...CONFIG, minimum_rest_hours: 16 };
    const looser = { ...CONFIG, minimum_rest_hours: 13 };

    const underDefault = scoreCandidates("Check-in", { start: "08:15", end: "08:45" }, EMPLOYEES, CONFIG);
    expect(underDefault.find((r) => r.employee.id === "hicham-bouzid")?.status).toBe("recommended");
    expect(underDefault.find((r) => r.employee.id === "rania-toumi")?.status).toBe("flagged");

    const underStricter = scoreCandidates("Check-in", { start: "08:15", end: "08:45" }, EMPLOYEES, stricter);
    expect(underStricter.find((r) => r.employee.id === "hicham-bouzid")?.status, "16h floor: Hicham's 15h no longer clears it").toBe("flagged");

    const underLooser = scoreCandidates("Check-in", { start: "08:15", end: "08:45" }, EMPLOYEES, looser);
    expect(underLooser.find((r) => r.employee.id === "rania-toumi")?.status, "13h floor: Rania's 13.75h now clears it").toBe("recommended");
  });

  it("checkRestBetweenDays: the SAME repeating shift pattern is compliant under the confirmed 15h floor and a violation once the configured floor is raised past it", () => {
    const employee = {
      id: "test-emp", name: "Test Employee", skills: [], assignment: "General T1 Pool",
      shift_code: "MT03", shift_start: null, shift_end: null, rest_before_shift_hours: null,
      weekly_hours: null, is_duty_officer: false, off_days: [], foreign_company_authorizations: [],
      active: true,
      // MT03 (POST-2026-09-20 regime): 05:45-14:45, 9h -> 24-9 = 15h rest
      // between two consecutive days of the identical repeating shift.
      weekly_shifts: [
        { day_of_week: "Monday", shift_code: "MT03", status: "working" as const },
        { day_of_week: "Tuesday", shift_code: "MT03", status: "working" as const },
      ],
    };
    const weekStart = "2026-09-21"; // a Monday, POST-regime

    const underDefault = checkRestBetweenDays(employee, ["Monday", "Tuesday"], CONFIG, weekStart);
    expect(underDefault).toEqual([]);

    const stricter = { ...CONFIG, minimum_rest_hours: 16 };
    const underStricter = checkRestBetweenDays(employee, ["Monday", "Tuesday"], stricter, weekStart);
    expect(underStricter).toHaveLength(1);
    expect(underStricter[0].type).toBe("rest_violation");
    expect(underStricter[0].description).toContain("15.0h rest");
    expect(underStricter[0].description).toContain("minimum required is 16h");
  });
});
