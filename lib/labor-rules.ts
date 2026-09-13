import { Employee } from "./types";

/**
 * Labor Rules = human-protection feasibility constraints only. They answer
 * "is this candidate rotation/shift pattern acceptable for a human," never
 * "which days does this team work" — that second question belongs to the
 * Rotation Feasibility Engine (lib/rotation-feasibility.ts), which treats
 * these rules as a pass/fail gate on candidates it generates, never as a
 * rotation-generation input by itself.
 *
 * Every rule value carries its own `source` so "confirmed" vs "prototype
 * placeholder, pending a real number" is never lost once a value is read.
 * `minimumRestHours` (15h) is a real, active, hard constraint, evaluated
 * continuously (every real shift-to-shift transition, never reset at a
 * calendar week boundary — see roster-generation.ts's restHoursBetween
 * and validation.ts's checkRestBetweenDays).
 *
 * `maximumAverageWeeklyWorkingHours` (42h) — renamed from the old
 * `maximumWeeklyWorkingHours` — is ALSO confirmed, but it is NOT a
 * Monday-Sunday calendar-week ceiling. Normal employee rosters are a
 * CONTINUOUS rotation across week boundaries (a displayed WeeklyPlan is
 * only a 7-day VIEW into that rotation, exactly like
 * lib/fixed-cycle-rotation.ts's Transit/Leaders cycle already models),
 * so "42h" is confirmed as an AVERAGE over some reference period, not a
 * per-displayed-week sum. The exact reference period
 * (`workingHoursReferencePeriodDays` below) is NOT YET CONFIRMED — do
 * not default it to 7, 14, or 28 days. Until it is configured, no code
 * may treat a single displayed week's total as sufficient to determine
 * 42h compliance one way or the other (see
 * lib/planning/average-hours.ts's evaluateAverageWorkingHours, which
 * returns an explicit not_evaluable state in that case, and
 * lib/planning/validation.ts's checkAverageWeeklyHours/
 * auditAverageWeeklyHoursFeasibility, which never emit a violation while
 * unconfigured).
 *
 * The `unconfirmed_prototype` source value in the LaborRuleSource union
 * below is what `workingHoursReferencePeriodDays` currently uses — it is
 * a real, active "not yet decided" state for that one field, not
 * decorative history.
 */
export type LaborRuleSource =
  | "confirmed_management_policy"
  | "confirmed_labor_code"
  | "confirmed_cba"
  | "unconfirmed_prototype";

export interface RuleValue<T> {
  value: T;
  source: LaborRuleSource;
}

/**
 * What a rule set can be scoped to. Every field is optional and an empty
 * scope ({}) matches every employee (the default/universal rule) — this is
 * deliberately NOT a company/team rotation lookup (see the explicit
 * instruction that rotation must never branch on company/team name).
 * `role` here means employment/workforce category (e.g. "Duty Officers"),
 * a genuine human-protection scoping dimension (different confirmed rest
 * rules for a night-shift-only category, say) — never used to encode a
 * foreign company's rotation.
 */
export interface LaborRuleScope {
  role?: string; // e.g. Employee.assignment, when a role-specific rule is confirmed
  contractType?: string; // reserved — not in the current data model, added only once confirmed
}

export interface LaborRules {
  id: string;
  scope: LaborRuleScope;
  effectiveFrom: string; // ISO date
  effectiveTo: string | null;
  // Confirmed: at least this many hours between the END of one working
  // shift and the START of the employee's next working shift, computed
  // from real shift timestamps (including overnight shifts that cross
  // midnight — see roster-generation.ts's restHoursBetween). Previously
  // an "unconfirmed_prototype" placeholder at 10h; now a real, confirmed
  // management policy value.
  minimumRestHours: RuleValue<number>;
  // The confirmed rule: a normal week has exactly 2 OFF/rest days.
  normalWeeklyOffDays: RuleValue<number>;
  // Only reachable via an explicit, human-invoked renfort decision —
  // never chosen automatically by ATLAS. No automation reads or sets this
  // per employee yet (that's future, explicitly out of scope for this
  // milestone); it exists here only so the rule is representable.
  renfortWeeklyOffDays: RuleValue<number>;
  // The confirmed rule: an employee must never have more than this many
  // CONSECUTIVE OFF days, evaluated across week boundaries (never a
  // single Monday-Sunday snapshot in isolation). This is a HUMAN-
  // PROTECTION constraint (how much rest is acceptable), not a rotation
  // policy — a fixed-cycle team's own sequence (see
  // lib/fixed-cycle-rotation.ts) is validated AGAINST this value, but the
  // sequence itself lives in the rotation engine, never here.
  maxConsecutiveOffDays: RuleValue<number>;
  // Confirmed: 42h is the maximum AVERAGE weekly working duration (sum of
  // scheduled shift durations, overnight shifts counted correctly),
  // averaged over `workingHoursReferencePeriodDays` below — never a
  // Monday-Sunday calendar-week sum by itself (see the module doc
  // comment above). This is a hard constraint a CONTINUOUS rotation must
  // satisfy over its real reference period; a single displayed week
  // running high (or low) is not, by itself, a violation or a pass.
  maximumAverageWeeklyWorkingHours: RuleValue<number>;
  // NOT YET CONFIRMED. The number of days the 42h average above is
  // computed over. `value: null` means "no reference period has been
  // configured yet" — this is a real, load-bearing state, not a
  // placeholder to be defaulted away. Do not set this to 7, 14, or 28
  // speculatively; every consumer must treat `null` as "cannot evaluate
  // average-hours compliance right now" (see
  // lib/planning/average-hours.ts).
  workingHoursReferencePeriodDays: RuleValue<number | null>;
}

/**
 * Only ONE rule set exists today because only the default/universal scope
 * has confirmed values. Do not add a scoped entry speculatively — add one
 * only once a real, confirmed, role/contract-specific rule exists.
 *
 * minimumRestHours (15h) and maximumAverageWeeklyWorkingHours (42h) are
 * both confirmed management-policy VALUES. Do not restore the old 10h or
 * 40h values anywhere. workingHoursReferencePeriodDays is deliberately
 * `unconfirmed_prototype` with `value: null` — the 42h number is
 * confirmed, the period it averages over is not, and those are two
 * separate facts (see the module doc comment above).
 *
 * normalWeeklyOffDays (2), renfortWeeklyOffDays (1), and
 * maxConsecutiveOffDays (2) remain confirmed and unchanged.
 * maxConsecutiveOffDays governs BOTH the ordinary weekly-roster
 * consecutive-OFF check and the hard feasibility gate the Rotation
 * Feasibility Engine applies to candidate rotations (see
 * lib/rotation-feasibility.ts) — one resolved number, one source of truth,
 * never a value re-declared at either call site.
 */
export const DEFAULT_LABOR_RULES: LaborRules[] = [
  {
    id: "default",
    scope: {},
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    minimumRestHours: { value: 15, source: "confirmed_management_policy" },
    normalWeeklyOffDays: { value: 2, source: "confirmed_management_policy" },
    renfortWeeklyOffDays: { value: 1, source: "confirmed_management_policy" },
    maxConsecutiveOffDays: { value: 2, source: "confirmed_management_policy" },
    maximumAverageWeeklyWorkingHours: { value: 42, source: "confirmed_management_policy" },
    workingHoursReferencePeriodDays: { value: null, source: "unconfirmed_prototype" },
  },
];

export interface ResolvedLaborRules {
  minimumRestHours: number;
  minimumRestHoursSource: LaborRuleSource;
  normalWeeklyOffDays: number;
  normalWeeklyOffDaysSource: LaborRuleSource;
  renfortWeeklyOffDays: number;
  renfortWeeklyOffDaysSource: LaborRuleSource;
  maxConsecutiveOffDays: number;
  maxConsecutiveOffDaysSource: LaborRuleSource;
  maximumAverageWeeklyWorkingHours: number;
  maximumAverageWeeklyWorkingHoursSource: LaborRuleSource;
  // null = not yet confirmed. See workingHoursReferencePeriodDays above.
  workingHoursReferencePeriodDays: number | null;
  workingHoursReferencePeriodDaysSource: LaborRuleSource;
}

function isEffective(rule: LaborRules, date: string): boolean {
  if (rule.effectiveFrom > date) return false;
  if (rule.effectiveTo && rule.effectiveTo < date) return false;
  return true;
}

function scopeSpecificity(scope: LaborRuleScope): number {
  return Object.values(scope).filter((v) => v !== undefined).length;
}

function scopeMatches(scope: LaborRuleScope, employee: Employee): boolean {
  if (scope.role !== undefined && scope.role !== employee.assignment) return false;
  // contractType has no data-model equivalent yet — a rule scoped to it
  // can never match until that field is confirmed and added.
  if (scope.contractType !== undefined) return false;
  return true;
}

/**
 * Resolves the applicable human-protection constraints for one employee on
 * one date. Picks the MOST SPECIFIC currently-effective rule that matches
 * — today that's always the single default entry, since no scoped rule is
 * confirmed yet, but the resolution mechanism itself already supports
 * adding one later (by role/contract/shift-family) without any caller
 * changing. `date` defaults to today; effective-dating is a real no-op
 * today (one rule set, always effective) but the shape is exercised, not
 * decorative.
 */
export function resolveLaborRules(
  employee: Employee,
  date: string = new Date().toISOString().slice(0, 10),
  rules: LaborRules[] = DEFAULT_LABOR_RULES
): ResolvedLaborRules {
  const candidates = rules.filter((r) => isEffective(r, date) && scopeMatches(r.scope, employee));
  if (candidates.length === 0) {
    throw new Error(
      `No effective labor rule set matches employee "${employee.id}" on ${date} — every employee must resolve to at least the default (unscoped) rule set.`
    );
  }

  candidates.sort((a, b) => scopeSpecificity(b.scope) - scopeSpecificity(a.scope));
  return unwrap(candidates[0]);
}

function unwrap(rule: LaborRules): ResolvedLaborRules {
  return {
    minimumRestHours: rule.minimumRestHours.value,
    minimumRestHoursSource: rule.minimumRestHours.source,
    normalWeeklyOffDays: rule.normalWeeklyOffDays.value,
    normalWeeklyOffDaysSource: rule.normalWeeklyOffDays.source,
    renfortWeeklyOffDays: rule.renfortWeeklyOffDays.value,
    renfortWeeklyOffDaysSource: rule.renfortWeeklyOffDays.source,
    maxConsecutiveOffDays: rule.maxConsecutiveOffDays.value,
    maxConsecutiveOffDaysSource: rule.maxConsecutiveOffDays.source,
    maximumAverageWeeklyWorkingHours: rule.maximumAverageWeeklyWorkingHours.value,
    maximumAverageWeeklyWorkingHoursSource: rule.maximumAverageWeeklyWorkingHours.source,
    workingHoursReferencePeriodDays: rule.workingHoursReferencePeriodDays.value,
    workingHoursReferencePeriodDaysSource: rule.workingHoursReferencePeriodDays.source,
  };
}

/**
 * Resolves the default (unscoped) rule set directly, for the rare
 * legitimate case of generating seed data BEFORE any Employee object
 * exists to resolve against (e.g. choosing an OFF-day count while still
 * building the employee record itself). Equivalent to resolveLaborRules()
 * for any employee, as long as no scoped rule is confirmed yet — once a
 * scoped rule exists, callers with a real Employee should prefer
 * resolveLaborRules() so scoping actually applies.
 */
export function resolveDefaultLaborRules(
  date: string = new Date().toISOString().slice(0, 10),
  rules: LaborRules[] = DEFAULT_LABOR_RULES
): ResolvedLaborRules {
  const defaultRule = rules.find((r) => scopeSpecificity(r.scope) === 0 && isEffective(r, date));
  if (!defaultRule) {
    throw new Error(`No effective default (unscoped) labor rule set found for ${date}.`);
  }
  return unwrap(defaultRule);
}
