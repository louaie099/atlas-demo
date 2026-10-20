import { Config } from "../types";
import { shiftCatalogForDate, getShiftDurationHours } from "../shift-templates";
import { computePaidHours } from "./paid-hours";
import { DEFAULT_BREAK_POLICY } from "../break-policy";
import { ConfigurationIssue } from "./validation";

/**
 * LABOR RULES v2 (2026-10-20) — a CONFIGURATION-level feasibility audit
 * (see validation.ts's ConfigurationIssue doc comment: a gap in ATLAS's
 * own rulebook, not a per-week operational finding) for the new
 * configurable rules. Catches an arithmetically-impossible combination of
 * values AT SAVE TIME, using only confirmed shift-catalog data — never a
 * guessed RAM policy number. Every check here is a pure "these two
 * configured numbers cannot both be satisfied" fact, not an opinion about
 * what the right number should be.
 *
 * Deliberately conservative: it only flags a combination that is
 * genuinely impossible for EVERY employee under EVERY legal shift code,
 * never a merely "unusual" or "tight" one. A real per-employee,
 * per-population feasibility check (accounting for which codes a specific
 * employee is actually eligible for) is a larger, population-aware
 * exercise outside this milestone's scope — see this milestone's
 * known-limitations note.
 */
export function auditLaborRuleConfigurationFeasibility(config: Config): ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];

  // A — trivial contradictions: a configured floor above its own ceiling.
  if (
    config.minimum_weekly_paid_hours !== null &&
    config.minimum_weekly_paid_hours !== undefined &&
    config.maximum_weekly_paid_hours !== null &&
    config.maximum_weekly_paid_hours !== undefined &&
    config.minimum_weekly_paid_hours > config.maximum_weekly_paid_hours
  ) {
    issues.push({
      requirementId: "labor-rules-weekly-paid-hours-contradiction",
      description: `Configured minimum weekly paid hours (${config.minimum_weekly_paid_hours}h) is greater than the configured maximum (${config.maximum_weekly_paid_hours}h) — no week can ever satisfy both at once.`,
    });
  }
  if (
    config.minimum_monthly_paid_hours !== null &&
    config.minimum_monthly_paid_hours !== undefined &&
    config.maximum_monthly_paid_hours !== null &&
    config.maximum_monthly_paid_hours !== undefined &&
    config.minimum_monthly_paid_hours > config.maximum_monthly_paid_hours
  ) {
    issues.push({
      requirementId: "labor-rules-monthly-paid-hours-contradiction",
      description: `Configured minimum monthly paid hours (${config.minimum_monthly_paid_hours}h) is greater than the configured maximum (${config.maximum_monthly_paid_hours}h) — no month can ever satisfy both at once.`,
    });
  }

  // B — a max-continuous-shift-duration ceiling below every real catalog
  // shift's own scheduled span: nobody could ever be legally assigned ANY
  // shift at all, which silently makes every generation-driven population
  // unstaffable rather than surfacing a clear configuration error. Checked
  // against a single reference date's catalog (shift durations are
  // effective-dated but the catalog's SHORTEST duration has stayed >= 7h
  // throughout this app's history — a shorter reference date is used only
  // to pick a concrete catalog, never to assume durations never change).
  if (config.max_continuous_shift_hours !== null && config.max_continuous_shift_hours !== undefined) {
    const referenceDate = "2026-10-20";
    const catalog = shiftCatalogForDate(referenceDate);
    const durations = Object.keys(catalog).map((code) => getShiftDurationHours(code, referenceDate));
    const shortest = Math.min(...durations);
    if (config.max_continuous_shift_hours < shortest) {
      issues.push({
        requirementId: "labor-rules-max-continuous-shift-hours-infeasible",
        description: `Configured maximum continuous shift duration (${config.max_continuous_shift_hours}h) is below every shift code's own scheduled span (the shortest is ${shortest}h) — no legal shift could ever be assigned under this ceiling, making every generation-driven population unstaffable.`,
      });
    }
  }

  // C — a minimum-weekly-paid-hours floor above what ANY combination of
  // legal work days (bounded by the hard minimum_off_days_per_planning_week
  // floor) and the longest available shift's own paid hours could ever
  // reach — a genuine arithmetic impossibility, not a tight-but-achievable
  // target.
  if (config.minimum_weekly_paid_hours !== null && config.minimum_weekly_paid_hours !== undefined) {
    const referenceDate = "2026-10-20";
    const catalog = shiftCatalogForDate(referenceDate);
    const breakPolicy = config.break_policy ?? DEFAULT_BREAK_POLICY;
    const longestPaidHours = Math.max(...Object.keys(catalog).map((code) => computePaidHours(code, referenceDate, breakPolicy).paidHours));
    const maxPossibleWorkDays = Math.max(0, 7 - config.minimum_off_days_per_planning_week);
    const maxAchievable = longestPaidHours * maxPossibleWorkDays;
    if (config.minimum_weekly_paid_hours > maxAchievable) {
      issues.push({
        requirementId: "labor-rules-minimum-weekly-paid-hours-infeasible",
        description: `Configured minimum weekly paid hours (${config.minimum_weekly_paid_hours}h) exceeds what is achievable even at the longest available shift (${longestPaidHours.toFixed(2)}h paid) across the maximum possible work days this planning week allows (${maxPossibleWorkDays}, given the ${config.minimum_off_days_per_planning_week}-day minimum OFF floor) — at most ${maxAchievable.toFixed(2)}h is reachable.`,
      });
    }
  }

  return issues;
}
