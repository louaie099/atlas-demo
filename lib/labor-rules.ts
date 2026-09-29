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
  // The confirmed NORMAL weekly roster structure, part 1 of 2 (see
  // normalWeeklyWorkDays below for part 2 — the two are stored as
  // INDEPENDENT explicit facts, never one inferred from the other or from
  // maxConsecutiveWorkDays, per the 2026-09-29 correction: "5 WORK" is not
  // merely "not-2-OFF", and is a genuinely different concept from the hard
  // consecutive-work-day cap). A normal week has exactly 2 OFF/rest days.
  normalWeeklyOffDays: RuleValue<number>;
  // The confirmed NORMAL weekly roster structure, part 2 of 2 — how many
  // days a normal flexible ACE works in a normal week (5). Deliberately its
  // OWN stored field, not derived as `7 - normalWeeklyOffDays` and NOT
  // derived from maxConsecutiveWorkDays (a different, HARD, cross-week-
  // boundary concept — see that field's own doc comment) — explicit,
  // independently editable, per the 2026-09-29 correction.
  normalWeeklyWorkDays: RuleValue<number>;
  // Only reachable via an explicit, human-invoked renfort decision —
  // never chosen automatically by ATLAS. No automation reads or sets this
  // per employee yet (that's future, explicitly out of scope for this
  // milestone); it exists here only so the rule is representable.
  renfortWeeklyOffDays: RuleValue<number>;
  // The confirmed RECOVERY-BLOCK POLICY: for NORMAL automatic flexible-ACE
  // generation, the 2 normal OFF days must be scheduled CONSECUTIVELY (a
  // "OO WWWWW" / "W OO WWWW" / ... shape), never silently split into
  // separated single OFF days just because that happens to improve
  // coverage. This is a genuinely DIFFERENT concept from maxConsecutiveOffDays
  // below (2026-09-29 correction, point 4): this field says the normal
  // pair must be TOGETHER; maxConsecutiveOffDays says a run of OFF days
  // must never be LONGER than some ceiling — a week could violate either
  // one without violating the other. Engine effect: lib/planning/shift-
  // generation.ts's generateFlexiblePoolShifts hard-excludes a flexible
  // ACE from Stage 6 on the days inside their own planned OFF/OFF window
  // (lib/planning/off-window.ts's planPreferredOffWindows, which already
  // SEARCHES every candidate window position for one demand can actually
  // support) when this is true — never a mere scoring tie-break a
  // sufficiently-good coverage score can silently outrank. When demand
  // genuinely cannot support ANY OFF/OFF placement without a coverage gap,
  // that gap is reported honestly (unfilled_duty) rather than the pair
  // being silently split — a human then explicitly APPROVES the exception
  // by manually assigning the employee via Find Agent, exactly as this
  // app's existing "ATLAS recommends, humans approve" convention already
  // works for every other genuine shortage (see duty-generation.ts).
  normalOffDaysConsecutive: RuleValue<boolean>;
  // The confirmed rule: an employee must never have more than this many
  // CONSECUTIVE OFF days, evaluated across week boundaries (never a
  // single Monday-Sunday snapshot in isolation) — a CEILING, unrelated to
  // whether the normal 2-day pair above happens to be scheduled together
  // (see normalOffDaysConsecutive's doc comment on why these are modeled
  // separately). This is a HUMAN-PROTECTION constraint (how much rest is
  // acceptable), not a rotation policy — a fixed-cycle team's own sequence
  // (see lib/fixed-cycle-rotation.ts) is validated AGAINST this value, but
  // the sequence itself lives in the rotation engine, never here.
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
  // NOT YET CONFIRMED — a genuinely different concept from the 42h value
  // above, not a rephrasing of it. Confirmed by RAM Handling (Moses,
  // 2026-09-17) as a real PRINCIPLE: an employee is scheduled to work
  // according to their real working-hours obligation, never purely
  // because that day's flight demand happens to justify it (see
  // docs/known-limitations/roster-planning-vs-duty-allocation.md) — an
  // employee with no specific flight duty during part of a scheduled
  // shift is still WORKING, available capacity, not OFF. What was
  // explicitly NOT confirmed is the actual number/shape of that
  // obligation (a flat weekly hours target, a minimum shift count, an
  // averaged target over some period, or something else). `value: null`
  // means "no real obligation target has been confirmed yet" — every
  // consumer must treat null as "cannot evaluate obligation compliance,
  // and cannot yet drive demand-independent roster generation from this
  // number" (see lib/planning/roster-obligation.ts). Do not default this
  // to `maximumAverageWeeklyWorkingHours` (42h) — that is a confirmed
  // CEILING on average hours, never confirmed as the target/floor every
  // employee should be scheduled to reach; conflating the two would be
  // guessing a business rule this codebase's own conventions exist to
  // avoid.
  workingHoursObligationHours: RuleValue<number | null>;
  // INTERNAL SAFETY DEFAULT, honestly labeled `unconfirmed_prototype`
  // (2026-09-29 correction, point 5) — NOT a confirmed, independent
  // company-wide labor rule. lib/planning/hard-work-caps.ts enforces a hard
  // pre-scoring filter (nobody is ever assigned a 6th+ consecutive calendar
  // work day) as an engineering safety guard, but the fact that normal
  // flexible-ACE rosters are configured for 5 WORK + 2 OFF
  // (normalWeeklyWorkDays above) does NOT, by itself, prove a separate
  // confirmed rule that nobody may EVER work more than 5 consecutive
  // calendar days across week boundaries. The NUMBER (5) is still sourced
  // from here as the one canonical value the engine's safety filter reads
  // (see hard-work-caps.ts's DEFAULT_MAX_CONSECUTIVE_WORK_DAYS) — only the
  // PROVENANCE changes, so the Planning Rules UI shows this honestly as an
  // engine safety default pending real confirmation, not as settled policy.
  maxConsecutiveWorkDays: RuleValue<number>;
  // NOT YET CONFIRMED, purely representable. A minimum buffer/movement time
  // between two duties for the same employee — no real number has been
  // confirmed by RAM Handling, and no generation or validation code reads
  // this value yet. `value: null` means "not configured" and must stay that
  // way until a real number is confirmed; do not invent one (e.g. by
  // guessing a plausible turnaround time). Exists here only so the rule is
  // representable in the Planning Rules UI, exactly like
  // renfortWeeklyOffDays/workingHoursObligationHours above.
  operationalBufferMinutes: RuleValue<number | null>;
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
 * normalWeeklyOffDays (2), normalWeeklyWorkDays (5), normalOffDaysConsecutive
 * (true), renfortWeeklyOffDays (1), and maxConsecutiveOffDays (2) remain
 * confirmed. maxConsecutiveOffDays governs BOTH the ordinary weekly-roster
 * consecutive-OFF check and the hard feasibility gate the Rotation
 * Feasibility Engine applies to candidate rotations (see
 * lib/rotation-feasibility.ts) — one resolved number, one source of truth,
 * never a value re-declared at either call site.
 *
 * maxConsecutiveWorkDays (5) is deliberately `unconfirmed_prototype`
 * (2026-09-29 correction) — see its own doc comment above for why this
 * differs from every other field here that shares its VALUE with a
 * confirmed rule.
 */
export const DEFAULT_LABOR_RULES: LaborRules[] = [
  {
    id: "default",
    scope: {},
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    minimumRestHours: { value: 15, source: "confirmed_management_policy" },
    normalWeeklyOffDays: { value: 2, source: "confirmed_management_policy" },
    normalWeeklyWorkDays: { value: 5, source: "confirmed_management_policy" },
    normalOffDaysConsecutive: { value: true, source: "confirmed_management_policy" },
    renfortWeeklyOffDays: { value: 1, source: "confirmed_management_policy" },
    maxConsecutiveOffDays: { value: 2, source: "confirmed_management_policy" },
    maximumAverageWeeklyWorkingHours: { value: 42, source: "confirmed_management_policy" },
    workingHoursReferencePeriodDays: { value: null, source: "unconfirmed_prototype" },
    workingHoursObligationHours: { value: null, source: "unconfirmed_prototype" },
    maxConsecutiveWorkDays: { value: 5, source: "unconfirmed_prototype" },
    operationalBufferMinutes: { value: null, source: "unconfirmed_prototype" },
  },
];

export interface ResolvedLaborRules {
  minimumRestHours: number;
  minimumRestHoursSource: LaborRuleSource;
  normalWeeklyOffDays: number;
  normalWeeklyOffDaysSource: LaborRuleSource;
  normalWeeklyWorkDays: number;
  normalWeeklyWorkDaysSource: LaborRuleSource;
  normalOffDaysConsecutive: boolean;
  normalOffDaysConsecutiveSource: LaborRuleSource;
  renfortWeeklyOffDays: number;
  renfortWeeklyOffDaysSource: LaborRuleSource;
  maxConsecutiveOffDays: number;
  maxConsecutiveOffDaysSource: LaborRuleSource;
  maximumAverageWeeklyWorkingHours: number;
  maximumAverageWeeklyWorkingHoursSource: LaborRuleSource;
  // null = not yet confirmed. See workingHoursReferencePeriodDays above.
  workingHoursReferencePeriodDays: number | null;
  workingHoursReferencePeriodDaysSource: LaborRuleSource;
  // null = not yet confirmed. See workingHoursObligationHours above.
  workingHoursObligationHours: number | null;
  workingHoursObligationHoursSource: LaborRuleSource;
  maxConsecutiveWorkDays: number;
  maxConsecutiveWorkDaysSource: LaborRuleSource;
  // null = not yet confirmed. See operationalBufferMinutes above.
  operationalBufferMinutes: number | null;
  operationalBufferMinutesSource: LaborRuleSource;
}

/**
 * `effectiveTo` is EXCLUSIVE: a rule is effective for `effectiveFrom <= date
 * < effectiveTo` (or forever, when `effectiveTo` is null). This matters once
 * more than one row can exist (2026-09-29, Planning Rules milestone):
 * lib/planning/rules-service.ts's saveLaborRuleEdit closes the previous
 * default row by setting its `effectiveTo` to the NEW row's own
 * `effectiveFrom` — so on that exact boundary date, only the NEW row must
 * match, never both (which an inclusive `effectiveTo` would allow, and
 * which callers that pick the first/most-specific match could then resolve
 * to either row depending on array order — a real latent bug this
 * exclusive convention avoids by construction, not by caller discipline).
 */
function isEffective(rule: LaborRules, date: string): boolean {
  if (rule.effectiveFrom > date) return false;
  if (rule.effectiveTo && rule.effectiveTo <= date) return false;
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
    normalWeeklyWorkDays: rule.normalWeeklyWorkDays.value,
    normalWeeklyWorkDaysSource: rule.normalWeeklyWorkDays.source,
    normalOffDaysConsecutive: rule.normalOffDaysConsecutive.value,
    normalOffDaysConsecutiveSource: rule.normalOffDaysConsecutive.source,
    renfortWeeklyOffDays: rule.renfortWeeklyOffDays.value,
    renfortWeeklyOffDaysSource: rule.renfortWeeklyOffDays.source,
    maxConsecutiveOffDays: rule.maxConsecutiveOffDays.value,
    maxConsecutiveOffDaysSource: rule.maxConsecutiveOffDays.source,
    maximumAverageWeeklyWorkingHours: rule.maximumAverageWeeklyWorkingHours.value,
    maximumAverageWeeklyWorkingHoursSource: rule.maximumAverageWeeklyWorkingHours.source,
    workingHoursReferencePeriodDays: rule.workingHoursReferencePeriodDays.value,
    workingHoursReferencePeriodDaysSource: rule.workingHoursReferencePeriodDays.source,
    workingHoursObligationHours: rule.workingHoursObligationHours.value,
    workingHoursObligationHoursSource: rule.workingHoursObligationHours.source,
    maxConsecutiveWorkDays: rule.maxConsecutiveWorkDays.value,
    maxConsecutiveWorkDaysSource: rule.maxConsecutiveWorkDays.source,
    operationalBufferMinutes: rule.operationalBufferMinutes.value,
    operationalBufferMinutesSource: rule.operationalBufferMinutes.source,
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

/**
 * How a rule is actually ENFORCED by the engine — display-only metadata for
 * the Planning Rules UI, never persisted and never user-editable. This is
 * deliberately a static, code-level fact (derived from how the value is
 * really used elsewhere in the codebase), not a field a user can flip: a
 * confirmed hard rule must never become "soft" just because someone wants
 * easier coverage in the UI.
 *
 *   "hard"           — a pre-scoring eligibility filter; a violation is
 *                       never assigned, only ever reported as a gap.
 *   "soft"            — a tie-break/preference; never blocks an assignment.
 *   "recommendation"  — surfaced as a non-blocking PlanIssue for human review.
 *   "not_evaluable"   — the rule is confirmed as a PRINCIPLE, but a
 *                       dependent value is still unconfirmed (null), so no
 *                       code currently evaluates compliance one way or the
 *                       other. See average-hours.ts / roster-obligation.ts.
 */
export type RuleSeverity = "hard" | "soft" | "recommendation" | "not_evaluable";

/** The value-only fields of ResolvedLaborRules (excludes the `*Source` provenance fields) — the UI's severity lookup key set. */
export type LaborRuleKey =
  | "minimumRestHours"
  | "normalWeeklyOffDays"
  | "normalWeeklyWorkDays"
  | "normalOffDaysConsecutive"
  | "renfortWeeklyOffDays"
  | "maxConsecutiveOffDays"
  | "maximumAverageWeeklyWorkingHours"
  | "workingHoursReferencePeriodDays"
  | "workingHoursObligationHours"
  | "maxConsecutiveWorkDays"
  | "operationalBufferMinutes";

export const LABOR_RULE_SEVERITY: Record<LaborRuleKey, RuleSeverity> = {
  minimumRestHours: "hard",
  normalWeeklyOffDays: "soft",
  normalWeeklyWorkDays: "soft",
  // HARD as of the 2026-09-29 correction: lib/planning/shift-generation.ts
  // now hard-excludes a flexible ACE from Stage 6 on their planned OFF/OFF
  // window days rather than merely penalizing the score — see this field's
  // own doc comment in the LaborRules interface above.
  normalOffDaysConsecutive: "hard",
  renfortWeeklyOffDays: "soft",
  maxConsecutiveOffDays: "hard",
  maximumAverageWeeklyWorkingHours: "not_evaluable",
  workingHoursReferencePeriodDays: "not_evaluable",
  workingHoursObligationHours: "not_evaluable",
  // Enforced as a hard pre-scoring filter (an engineering safety default),
  // but its VALUE is not itself an independently confirmed labor rule — see
  // this field's own doc comment. Severity describes ENFORCEMENT; the
  // resolved rule's own `*Source` describes CONFIRMATION status — the two
  // are shown separately in the UI.
  maxConsecutiveWorkDays: "hard",
  operationalBufferMinutes: "not_evaluable",
};
