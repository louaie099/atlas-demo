-- Additive migration — run AFTER 0001 through 0013, 0015.
-- Introduces persistence for lib/labor-rules.ts's LaborRules concept (see
-- lib/planning/rules-service.ts): until now DEFAULT_LABOR_RULES was an
-- in-memory constant with no way for a planner to actually change it. Rows
-- here mirror the LaborRules shape one-to-one (id/scope/effectiveFrom/
-- effectiveTo, plus every RuleValue<T> field as a single `rules` jsonb
-- blob) so lib/labor-rules.ts's existing resolveLaborRules/
-- resolveDefaultLaborRules resolution logic can run against DB-loaded rows
-- exactly as it already does against the static array — no second
-- resolution mechanism.
--
-- An empty table (the state right after this migration runs, and right
-- after Reset Demo) means "no rule edit has ever been saved" — resolution
-- falls back to the static DEFAULT_LABOR_RULES, never an error and never a
-- silently-guessed value.
--
-- A rule edit is never an UPDATE in place: lib/planning/rules-service.ts's
-- saveLaborRuleEdit closes the previously-effective row (sets its
-- effective_to) and INSERTS a new one, so the table is a real, queryable
-- version history — "Rules must be effective-dated/versionable."
create table planning_labor_rules (
  id text primary key,
  scope jsonb not null default '{}'::jsonb,
  effective_from text not null,
  effective_to text,
  rules jsonb not null
);

create index idx_planning_labor_rules_effective on planning_labor_rules(effective_from, effective_to);

-- Fatigue-burden model configuration (lib/fatigue-config.ts) -- kept in its
-- OWN table, deliberately separate from planning_labor_rules above: fatigue
-- is a prototype/unconfirmed preference (see that module's own doc comment,
-- "NOT validated scientific fatigue coefficients... NOT confirmed by RAM
-- Handling"), not a confirmed human-protection labor rule, and it does not
-- need effective-dated version history the way a real labor-policy change
-- does -- a single mutable "current settings" row is enough. Missing row =
-- "never edited yet" -- resolution falls back to the static
-- DEFAULT_FATIGUE_CONFIG (disabled), same convention as
-- planning_labor_rules' empty-table fallback.
create table planning_fatigue_config (
  id text primary key default 'current',
  config jsonb not null,
  updated_at timestamptz not null default now()
);
