import { SupabaseClient } from "@supabase/supabase-js";
import { Config } from "../types";
import { LaborRules, DEFAULT_LABOR_RULES, resolveDefaultLaborRules, ResolvedLaborRules, RuleValue, LaborRuleKey } from "../labor-rules";
import { buildConfigFromResolvedRules } from "../seed-data";
import { FatigueConfig, DEFAULT_FATIGUE_CONFIG } from "../fatigue-config";

/**
 * PLANNING RULES PERSISTENCE (2026-09-29 milestone). Until now
 * lib/labor-rules.ts's DEFAULT_LABOR_RULES was an in-memory constant with no
 * way for a planner to actually change it -- this module is the persistence
 * layer that makes it a real, editable, versioned rule set, without
 * introducing a second resolution mechanism: every read here still goes
 * through labor-rules.ts's own resolveDefaultLaborRules, just against
 * DB-loaded rows instead of the static array.
 *
 * An empty `planning_labor_rules` table (a fresh DB, or right after Reset
 * Demo -- see lib/reset-database.ts) means "no edit has ever been saved" --
 * resolution falls back to the static DEFAULT_LABOR_RULES, never an error.
 *
 * Only the single unscoped ("default") rule is ever written by this
 * milestone's UI -- see lib/labor-rules.ts's LaborRuleScope doc comment on
 * why a per-population scoped rule is not yet exposed (no such rule is
 * confirmed today, and inventing one would guess a business rule this
 * codebase's own conventions exist to avoid).
 */

interface PlanningLaborRuleRow {
  id: string;
  scope: LaborRules["scope"];
  effective_from: string;
  effective_to: string | null;
  rules: Omit<LaborRules, "id" | "scope" | "effectiveFrom" | "effectiveTo">;
}

function rowToLaborRules(row: PlanningLaborRuleRow): LaborRules {
  // A row persisted BEFORE a RuleValue field existed (e.g.
  // minimumOffDaysPerPlanningWeek, added 2026-09-29 OFF/OFF phase 1) has no
  // key for it in its `rules` jsonb blob -- that field falls back to the
  // static default rule's own value+source (never a guessed number, and
  // never a crash in labor-rules.ts's unwrap). Every field the row DOES
  // carry wins, so an old edit is never overwritten by a default.
  return {
    id: row.id,
    scope: row.scope,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    ...STATIC_DEFAULT_RULE_VALUES,
    ...row.rules,
  };
}

function laborRulesToRow(rules: LaborRules): PlanningLaborRuleRow {
  const { id, scope, effectiveFrom, effectiveTo, ...rest } = rules;
  return { id, scope, effective_from: effectiveFrom, effective_to: effectiveTo, rules: rest };
}

/** The static default rule's RuleValue fields -- the per-field fallback rowToLaborRules applies to rows persisted before a field existed. */
const STATIC_DEFAULT_RULE_VALUES: PlanningLaborRuleRow["rules"] = laborRulesToRow(DEFAULT_LABOR_RULES[0]).rules;

/**
 * Loads every persisted LaborRules entry, oldest first. Falls back to the
 * static DEFAULT_LABOR_RULES when the table has never been written to --
 * this is the ONLY fallback point; every other function in this module goes
 * through this one so the two can never disagree.
 */
export async function loadLaborRules(supabase: SupabaseClient): Promise<LaborRules[]> {
  const { data, error } = await supabase.from("planning_labor_rules").select("*");
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as PlanningLaborRuleRow[];
  if (rows.length === 0) return DEFAULT_LABOR_RULES;
  return [...rows].sort((a, b) => a.effective_from.localeCompare(b.effective_from)).map(rowToLaborRules);
}

/**
 * Every RuleValue<T> field of the default rule set, unwrapped to its plain
 * value -- what this milestone's UI can edit (the UI never edits
 * `source`/provenance directly; see saveLaborRuleEdit for how a value's
 * source is decided on save).
 */
export type EditableRuleValues = Pick<ResolvedLaborRules, LaborRuleKey>;

/**
 * Loads the currently-saved fatigue configuration, or DEFAULT_FATIGUE_CONFIG
 * (disabled) if it has never been edited -- deliberately a single mutable
 * "current settings" row (planning_fatigue_config), not an effective-dated
 * history like planning_labor_rules: fatigue is a prototype/unconfirmed
 * preference (see lib/fatigue-config.ts's own doc comment), not a confirmed
 * labor policy that needs a real version history.
 */
export async function loadFatigueConfig(supabase: SupabaseClient): Promise<FatigueConfig> {
  const { data, error } = await supabase.from("planning_fatigue_config").select("*").eq("id", "current");
  if (error) throw new Error(error.message);
  const row = (data ?? [])[0] as { config: FatigueConfig } | undefined;
  return row?.config ?? DEFAULT_FATIGUE_CONFIG;
}

/** Overwrites the current fatigue configuration (upsert by the fixed id "current"). */
export async function saveFatigueConfig(supabase: SupabaseClient, config: FatigueConfig): Promise<FatigueConfig> {
  const { error } = await supabase.from("planning_fatigue_config").upsert({ id: "current", config, updated_at: new Date().toISOString() }, { onConflict: "id" });
  if (error) throw new Error(error.message);
  return config;
}

/**
 * Resolves the currently-effective Config, from DB-persisted rules/fatigue
 * when any exist, otherwise the static defaults -- the single function
 * every real generation call site (the API routes under
 * app/api/planning/) should call instead of importing the static CONFIG
 * singleton from lib/seed-data.ts.
 */
export async function resolveEffectiveConfig(supabase: SupabaseClient, date?: string): Promise<Config> {
  const [rules, fatigue] = await Promise.all([loadLaborRules(supabase), loadFatigueConfig(supabase)]);
  const resolved = resolveDefaultLaborRules(date, rules);
  return { ...buildConfigFromResolvedRules(resolved), fatigue };
}

/**
 * Applies an edit to the default (unscoped) rule set: closes out the
 * currently-effective default row (`effective_to` = today) and inserts a
 * new one (`effective_from` = today, `effective_to` = null) carrying the
 * merged values -- a real version history, never an in-place mutation (see
 * this module's doc comment and supabase/migrations/0016_planning_rules.sql).
 * Every edited field's `source` becomes `confirmed_management_policy` --
 * this UI is for a planner making a real operational decision, not for
 * representing an unconfirmed/prototype value (those stay null/unedited
 * unless a real number is actually entered).
 */
export async function saveLaborRuleEdit(
  supabase: SupabaseClient,
  edits: Partial<EditableRuleValues>,
  // EFFECTIVE-DATED, NOT hard-wired to today (2026-09-29 correction, point
  // 6): a caller MAY supply a future effective date to configure a rule for
  // an upcoming operational period without waiting until that day arrives.
  // The prototype UI defaults to today (no scheduling UI built yet), but
  // the service model itself must not assume every edit takes effect
  // immediately. `resolutionDate` defaults to `effectiveFrom` itself (the
  // natural "what does the rule set look like right before this edit
  // begins" baseline for merging partial edits over the current values).
  effectiveFrom: string = new Date().toISOString().slice(0, 10),
  resolutionDate: string = effectiveFrom
): Promise<LaborRules> {
  const existingRules = await loadLaborRules(supabase);
  const current = resolveDefaultLaborRules(resolutionDate, existingRules);
  const merged: EditableRuleValues = { ...current, ...edits };

  const wrap = <T>(value: T): RuleValue<T> => ({ value, source: "confirmed_management_policy" });
  const newRule: LaborRules = {
    id: `default-${effectiveFrom}-${Date.now()}`,
    scope: {},
    effectiveFrom,
    effectiveTo: null,
    minimumRestHours: wrap(merged.minimumRestHours),
    normalWeeklyOffDays: wrap(merged.normalWeeklyOffDays),
    normalWeeklyWorkDays: wrap(merged.normalWeeklyWorkDays),
    normalOffDaysConsecutive: wrap(merged.normalOffDaysConsecutive),
    minimumOffDaysPerPlanningWeek: wrap(merged.minimumOffDaysPerPlanningWeek),
    renfortWeeklyOffDays: wrap(merged.renfortWeeklyOffDays),
    maxConsecutiveOffDays: wrap(merged.maxConsecutiveOffDays),
    maximumAverageWeeklyWorkingHours: wrap(merged.maximumAverageWeeklyWorkingHours),
    workingHoursReferencePeriodDays: wrap(merged.workingHoursReferencePeriodDays),
    workingHoursObligationHours: wrap(merged.workingHoursObligationHours),
    // An explicit human edit of this value through the Planning Rules UI IS
    // a real, deliberate management decision — the DEFAULT (never-edited)
    // seed value is what stays honestly unconfirmed_prototype (see
    // DEFAULT_LABOR_RULES). Wrapped as confirmed here like every other
    // field, uniformly.
    maxConsecutiveWorkDays: wrap(merged.maxConsecutiveWorkDays),
    operationalBufferMinutes: wrap(merged.operationalBufferMinutes),
  };

  // Find the row that would otherwise still be open-ended at the moment
  // the new rule begins (there may be none yet, if this is the first-ever
  // edit and resolution fell back to the static DEFAULT_LABOR_RULES, which
  // has no DB row to close) — closing it at `effectiveFrom` (not
  // necessarily today) keeps a future-dated edit from retroactively
  // changing what resolves for dates between now and then.
  const { data: existingRows, error: readError } = await supabase.from("planning_labor_rules").select("*");
  if (readError) throw new Error(readError.message);
  const currentDefaultRow = ((existingRows ?? []) as PlanningLaborRuleRow[])
    .filter((r) => Object.keys(r.scope ?? {}).length === 0 && !r.effective_to)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];

  if (currentDefaultRow) {
    const { error: updateError } = await supabase.from("planning_labor_rules").update({ effective_to: effectiveFrom }).eq("id", currentDefaultRow.id);
    if (updateError) throw new Error(updateError.message);
  }

  const { error: insertError } = await supabase.from("planning_labor_rules").insert(laborRulesToRow(newRule));
  if (insertError) throw new Error(insertError.message);

  return newRule;
}
