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
 * placeholder, pending a real number" is never lost once a value is read —
 * this is what lets `weeklyHoursCeiling` stay honestly "unconfirmed"
 * (never a guessed number) while `normalWeeklyOffDays` is genuinely
 * confirmed and active.
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
  minimumRestHours: RuleValue<number>;
  // The confirmed rule: a normal week has exactly 2 OFF/rest days.
  normalWeeklyOffDays: RuleValue<number>;
  // Only reachable via an explicit, human-invoked renfort decision —
  // never chosen automatically by ATLAS. No automation reads or sets this
  // per employee yet (that's future, explicitly out of scope for this
  // milestone); it exists here only so the rule is representable.
  renfortWeeklyOffDays: RuleValue<number>;
  // "unconfirmed" is a real, literal state — never replaced with a guessed
  // number. Code that reads this must treat "unconfirmed" as "do not
  // enforce, do not use to drive generation," not as a missing value to
  // fill in.
  weeklyHoursCeiling: RuleValue<number | "unconfirmed">;
}

/**
 * Only ONE rule set exists today because only the default/universal scope
 * has confirmed values. Do not add a scoped entry speculatively — add one
 * only once a real, confirmed, role/contract-specific rule exists.
 *
 * minimumRestHours (10h) is carried over UNCHANGED from the previous
 * prototype value — not invented, not silently confirmed either. It is
 * explicitly marked "unconfirmed_prototype" so nothing downstream can
 * mistake it for a confirmed labor-code number. It still functions as the
 * operative rest constraint (rest protection has to mean something even
 * before a real number is confirmed), it's just honestly labeled.
 *
 * normalWeeklyOffDays (2) and renfortWeeklyOffDays (1) ARE confirmed —
 * stated explicitly as the real rule.
 *
 * weeklyHoursCeiling stays "unconfirmed" — the old 40h prototype value is
 * deliberately NOT carried forward as a number. It must never again drive
 * OFF-day count or rotation generation; see roster-generation.ts and
 * employee-generator.ts, which no longer read a ceiling for that purpose.
 */
export const DEFAULT_LABOR_RULES: LaborRules[] = [
  {
    id: "default",
    scope: {},
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    minimumRestHours: { value: 10, source: "unconfirmed_prototype" },
    normalWeeklyOffDays: { value: 2, source: "confirmed_management_policy" },
    renfortWeeklyOffDays: { value: 1, source: "confirmed_management_policy" },
    weeklyHoursCeiling: { value: "unconfirmed", source: "unconfirmed_prototype" },
  },
];

export interface ResolvedLaborRules {
  minimumRestHours: number;
  minimumRestHoursSource: LaborRuleSource;
  normalWeeklyOffDays: number;
  normalWeeklyOffDaysSource: LaborRuleSource;
  renfortWeeklyOffDays: number;
  renfortWeeklyOffDaysSource: LaborRuleSource;
  weeklyHoursCeiling: number | "unconfirmed";
  weeklyHoursCeilingSource: LaborRuleSource;
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
    weeklyHoursCeiling: rule.weeklyHoursCeiling.value,
    weeklyHoursCeilingSource: rule.weeklyHoursCeiling.source,
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
