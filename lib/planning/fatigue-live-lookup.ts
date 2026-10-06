import { SupabaseClient } from "@supabase/supabase-js";

import { Employee, WeeklyPlanRosterEntry } from "../types";
import { FatigueConfig } from "../fatigue-config";
import { FatigueStateOrUnknown } from "./fatigue-model";
import { FatigueSeedInput, deriveIncomingFatigueState } from "./fatigue-continuity";
import { createFatigueLedger, advanceFatigueLedger } from "./fatigue-planning";
import { flightDateFor } from "../flight-date";
import { isGenerationDrivenPopulation } from "./workforce-pools";
import { lookupPriorWeekBoundaryContext } from "./weekly-plan-service";

/**
 * LIVE fatigue lookup (2026-10-06, fatigue activation milestone) — gives
 * Find Agent / Live Operations replacement-candidate ranking
 * (lib/planning/candidate-lookup.ts) the SAME per-employee "state entering
 * day X" lib/planning/generate-draft-plan.ts already computes for Stage 9
 * duty scoring (see that file's own `fatigueStatesEnteringDay` construction
 * around its Stage-9 loop), but for ONE target date on demand, against a
 * plan that already exists, rather than for every day of a fresh
 * generation run. This is NOT a second fatigue engine — every real step
 * (continuity seeding, the day-by-day ledger, the burden math) is the
 * existing fatigue-continuity.ts/fatigue-planning.ts/fatigue-model.ts
 * machinery, reused exactly as designed; this module only orchestrates the
 * call order for a single on-demand lookup.
 *
 * Returns an EMPTY map when `config.enabled` is false — never computes
 * anything in that case, matching every other fatigue call site's
 * no-op-when-disabled contract.
 */

function previousCalendarDate(date: string): string {
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function buildFatigueStatesEnteringDate(
  supabase: SupabaseClient,
  config: FatigueConfig,
  weekStart: string,
  daysOrder: string[],
  targetDate: string,
  employees: Employee[],
  rosterRows: WeeklyPlanRosterEntry[]
): Promise<ReadonlyMap<string, FatigueStateOrUnknown>> {
  if (!config.enabled) return new Map();

  // Same three-way continuity provenance every other fatigue call site
  // uses (see buildDraftPlanBundle's own fatigueOptions construction):
  // a real predecessor plan's roster when one exists, otherwise the
  // static-baseline fallback (authoritative only for non-demand-driven
  // employees — deriveIncomingFatigueState itself enforces that).
  const prior = await lookupPriorWeekBoundaryContext(supabase, weekStart, daysOrder, employees);
  const fatigueSeedInput: FatigueSeedInput = prior
    ? { kind: "prior_plan", priorPlanRosterEntries: prior.priorRosterEntries, weekStart, daysOrder }
    : { kind: "fallback_static_baseline", weekStart, daysOrder };

  const incomingStates = new Map(employees.map((e) => [e.id, deriveIncomingFatigueState(e, fatigueSeedInput, config).state]));

  const ledger = createFatigueLedger(
    employees.map((e) => e.id),
    config,
    incomingStates,
    prior?.context,
    previousCalendarDate(flightDateFor(weekStart, daysOrder[0]))
  );

  for (const day of daysOrder) {
    const date = flightDateFor(weekStart, day);
    if (date === targetDate) break;

    const worked = new Map<string, string>();
    for (const row of rosterRows) {
      if (row.day_of_week === day && row.status === "working" && row.shift_code) worked.set(row.employee_id, row.shift_code);
    }
    // Static/fixed-team employees never have weekly_plan_roster_entries
    // rows (those are generation-driven-population-only — see
    // generate-draft-plan.ts's own identical fold) — their worked code for
    // the day comes from their own weekly_shifts instead, exactly as
    // Stage 9's fatigueStatesEnteringDay construction already does.
    for (const employee of employees) {
      if (isGenerationDrivenPopulation(employee)) continue;
      const entry = employee.weekly_shifts.find((s) => s.day_of_week === day);
      if (entry?.status === "working" && entry.shift_code) worked.set(employee.id, entry.shift_code);
    }

    advanceFatigueLedger(ledger, date, worked);
  }

  return new Map(ledger.states);
}
