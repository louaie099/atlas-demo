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
 * As of this revision every field below is confirmed_management_policy —
 * `minimumRestHours` (15h) and `maximumWeeklyWorkingHours` (42h) were the
 * last two still marked "unconfirmed_prototype"/"unconfirmed"; both are
 * now real, active, hard constraints. The `unconfirmed_prototype` source
 * value itself is kept in the LaborRuleSource union below only so a
 * FUTURE genuinely-unconfirmed rule can still be represented honestly —
 * it does not describe anything in DEFAULT_LABOR_RULES today.
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
  // Confirmed: the maximum total counted working duration (sum of
  // scheduled shift durations, overnight shifts counted correctly) across
  // one employee's normal week. Previously "unconfirmed" (the old 40h
  // prototype value was deliberately never carried forward as a number);
  // now a real, confirmed 42h ceiling. This is a HARD constraint a roster
  // must satisfy BEFORE it is generated, never a number a plan is allowed
  // to exceed and merely get flagged for afterward — see
  // lib/planning/validation.ts's checkWeeklyHoursCeiling (final-validation
  // gate) and lib/planning/shift-generation.ts (generation-time gate for
  // the flexible pool, the only place shift SELECTION happens day-by-day).
  maximumWeeklyWorkingHours: RuleValue<number>;
}

/**
 * Only ONE rule set exists today because only the default/universal scope
 * has confirmed values. Do not add a scoped entry speculatively — add one
 * only once a real, confirmed, role/contract-specific rule exists.
 *
 * minimumRestHours (15h) and maximumWeeklyWorkingHours (42h) are now BOTH
 * confirmed management-policy values, replacing the old 10h
 * "unconfirmed_prototype" rest placeholder and the "unconfirmed" hours
 * ceiling respectively. Do not restore the old 10h or 40h values anywhere
 * — those numbers no longer exist in this codebase as anything other than
 * history in comments like this one.
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
    maximumWeeklyWorkingHours: { value: 42, source: "confirmed_management_policy" },
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
  maximumWeeklyWorkingHours: number;
  maximumWeeklyWorkingHoursSource: LaborRuleSource;
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
    maximumWeeklyWorkingHours: rule.maximumWeeklyWorkingHours.value,
    maximumWeeklyWorkingHoursSource: rule.maximumWeeklyWorkingHours.source,
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
