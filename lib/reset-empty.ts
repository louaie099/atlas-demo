import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Wipes every table to a genuinely empty database — no reseeding, no
 * dataset, no generated plan. This is deliberately the ONLY thing "Reset"
 * does now (2026-10-20 UX change): the old single "Reset Demo" button
 * conflated two different actions (wipe everything; then immediately
 * reload one specific hardcoded dataset), which meant there was no way to
 * get to an empty database, and no way to switch datasets without first
 * sitting through a full dataset's worth of generation you didn't want.
 *
 * Those two actions are now separate:
 *   - Reset (this function / POST /api/reset-empty) -> wipes everything,
 *     leaves the database at a true, empty baseline (0 employees, 0
 *     flights, 0 of anything).
 *   - Load a dataset (POST /api/reset, /api/reset-small-demo, or
 *     /api/reset-poc-demo, all unchanged) -> wipes everything AND
 *     reseeds+generates one specific dataset, exactly as all three
 *     already did before this change.
 *
 * This file intentionally does not import or depend on any dataset
 * (lib/seed-data.ts, lib/demo-small/*, lib/demo-poc/*): it only needs to
 * know the FK-safe delete order, which it copies verbatim from
 * lib/reset-database.ts / lib/reset-small-demo.ts / lib/reset-poc-demo.ts
 * (all three already agree on this exact order, since none of those three
 * datasets are ever meant to coexist). If a future table is added to that
 * shared delete sequence, it must be added here too.
 */
export async function resetToEmptyDatabase(supabase: SupabaseClient): Promise<void> {
  await supabase.from("audit_log_entries").delete().neq("id", "");
  await supabase.from("assignment_modifications").delete().neq("id", "");
  await supabase.from("assignments").delete().neq("id", "");
  await supabase.from("weekly_plan_roster_entries").delete().neq("id", "");
  await supabase.from("weekly_plans").delete().neq("id", "");
  await supabase.from("planned_duties").delete().neq("id", "");
  await supabase.from("staffing_requirements").delete().neq("id", "");
  await supabase.from("flights").delete().neq("id", "");
  await supabase.from("employees").delete().neq("id", "");
  await supabase.from("planning_labor_rules").delete().neq("id", "");
  await supabase.from("planning_fatigue_config").delete().neq("id", "");
}
