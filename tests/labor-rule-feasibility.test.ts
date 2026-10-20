import { describe, it, expect } from "vitest";
import { auditLaborRuleConfigurationFeasibility } from "../lib/planning/labor-rule-feasibility";
import { CONFIG } from "../lib/seed-data";
import { Config } from "../lib/types";

describe("auditLaborRuleConfigurationFeasibility (LABOR RULES v2, 2026-10-20)", () => {
  it("the real demo config (nothing new configured) reports no conflicts at all", () => {
    expect(auditLaborRuleConfigurationFeasibility(CONFIG)).toEqual([]);
  });

  it("flags a weekly paid-hours min > max contradiction", () => {
    const config: Config = { ...CONFIG, minimum_weekly_paid_hours: 50, maximum_weekly_paid_hours: 40 };
    const issues = auditLaborRuleConfigurationFeasibility(config);
    expect(issues.some((i) => i.requirementId === "labor-rules-weekly-paid-hours-contradiction")).toBe(true);
  });

  it("flags a monthly paid-hours min > max contradiction", () => {
    const config: Config = { ...CONFIG, minimum_monthly_paid_hours: 200, maximum_monthly_paid_hours: 150 };
    const issues = auditLaborRuleConfigurationFeasibility(config);
    expect(issues.some((i) => i.requirementId === "labor-rules-monthly-paid-hours-contradiction")).toBe(true);
  });

  it("never flags a weekly/monthly pair that is merely tight but not contradictory", () => {
    const config: Config = { ...CONFIG, minimum_weekly_paid_hours: 20, maximum_weekly_paid_hours: 45 };
    expect(auditLaborRuleConfigurationFeasibility(config)).toEqual([]);
  });

  it("flags a max-continuous-shift-hours ceiling below every real catalog shift's own span", () => {
    const config: Config = { ...CONFIG, max_continuous_shift_hours: 1 };
    const issues = auditLaborRuleConfigurationFeasibility(config);
    expect(issues.some((i) => i.requirementId === "labor-rules-max-continuous-shift-hours-infeasible")).toBe(true);
  });

  it("never flags a reasonable max-continuous-shift-hours ceiling (e.g. 13h, above every real shift's span)", () => {
    const config: Config = { ...CONFIG, max_continuous_shift_hours: 13 };
    expect(auditLaborRuleConfigurationFeasibility(config).some((i) => i.requirementId.includes("max-continuous-shift-hours"))).toBe(false);
  });

  it("flags a minimum-weekly-paid-hours floor no combination of legal work days could ever reach", () => {
    const config: Config = { ...CONFIG, minimum_weekly_paid_hours: 500 }; // absurdly high, impossible under any catalog shift
    const issues = auditLaborRuleConfigurationFeasibility(config);
    expect(issues.some((i) => i.requirementId === "labor-rules-minimum-weekly-paid-hours-infeasible")).toBe(true);
  });

  it("never flags a realistic minimum-weekly-paid-hours floor (e.g. 20h)", () => {
    const config: Config = { ...CONFIG, minimum_weekly_paid_hours: 20 };
    expect(auditLaborRuleConfigurationFeasibility(config).some((i) => i.requirementId.includes("minimum-weekly-paid-hours"))).toBe(false);
  });
});
