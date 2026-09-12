import { describe, it, expect } from "vitest";
import { resolveDefaultLaborRules, DEFAULT_LABOR_RULES } from "../lib/labor-rules";
import { CONFIG } from "../lib/seed-data";

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

  it("maximumWeeklyWorkingHours is confirmed at 42h — the old 40h ceiling is never reintroduced, and it's no longer 'unconfirmed'", () => {
    expect(resolved.maximumWeeklyWorkingHours).toBe(42);
    expect(resolved.maximumWeeklyWorkingHours).not.toBe(40);
    expect(resolved.maximumWeeklyWorkingHoursSource).toBe("confirmed_management_policy");
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

  it("CONFIG.minimum_rest_hours / maximum_weekly_working_hours mirror the resolved labor rules exactly — never a hardcoded 15/42 of CONFIG's own", () => {
    const resolved = resolveDefaultLaborRules();
    expect(CONFIG.minimum_rest_hours).toBe(resolved.minimumRestHours);
    expect(CONFIG.maximum_weekly_working_hours).toBe(resolved.maximumWeeklyWorkingHours);
  });
});
