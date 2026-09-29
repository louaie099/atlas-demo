import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
export const dynamic = "force-dynamic";

import { loadLaborRules, saveLaborRuleEdit, loadFatigueConfig, saveFatigueConfig, EditableRuleValues } from "@/lib/planning/rules-service";
import { resolveDefaultLaborRules, LABOR_RULE_SEVERITY } from "@/lib/labor-rules";
import { FatigueConfig } from "@/lib/fatigue-config";

/**
 * Planning Rules -- the single endpoint behind the Weekly Planning page's
 * compact rules bar and its "Edit rules" drawer (components/planning-rules-
 * bar.tsx, components/planning-rules-sheet.tsx). See
 * lib/planning/rules-service.ts's own doc comment for the persistence
 * model this reads/writes.
 *
 * GET returns the currently-effective resolved rules plus a static
 * severity map (lib/labor-rules.ts's LABOR_RULE_SEVERITY) so the client
 * never has to hardcode which fields are HARD/SOFT/not_evaluable -- that
 * classification is a code-level fact about how the engine enforces each
 * value, not something this route or the UI decides per request.
 *
 * Fatigue is returned alongside the labor rules but is NOT part of
 * lib/labor-rules.ts's LaborRules/DEFAULT_LABOR_RULES resolution -- it has
 * its own single-row persistence (planning_fatigue_config, no version
 * history) matching lib/fatigue-config.ts's "prototype, unconfirmed"
 * framing, distinct from a confirmed labor policy's real effective-dating.
 */
export async function GET() {
  const supabase = getSupabaseServerClient();
  // 2026-09-29 fix: this previously had no try/catch, so a genuine
  // Supabase error from loadLaborRules/loadFatigueConfig (eg. a missing
  // planning_labor_rules/planning_fatigue_config table when migration 0016
  // has not been applied) propagated as an UNCAUGHT exception out of this
  // route handler -- Next.js then returns its own generic, non-JSON 500
  // page, which the client couldn't parse into an error message at all.
  // This still throws (never silently falls back to defaults -- that
  // distinction lives in rules-service.ts and is unchanged), it is simply
  // now turned into a proper JSON error response, exactly like PUT below
  // already does for its own write path.
  try {
    const [rules, fatigue] = await Promise.all([loadLaborRules(supabase), loadFatigueConfig(supabase)]);
    const resolved = resolveDefaultLaborRules(undefined, rules);
    return NextResponse.json({ resolved, severity: LABOR_RULE_SEVERITY, fatigue }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

/**
 * Applies an edit to the default (unscoped) rule set and/or the fatigue
 * config -- either or both keys may be present. `laborRules` goes through
 * saveLaborRuleEdit (a new effective-dated row, never an in-place mutation
 * -- see that function's own doc comment); `fatigue`, if present, REPLACES
 * the whole FatigueConfig (a plain overwrite -- see saveFatigueConfig).
 * Returns the freshly resolved rules so the client can update its own
 * state from the actual persisted result rather than optimistically
 * echoing back what it sent.
 *
 * No validation beyond what saveLaborRuleEdit itself does (type shape via
 * TypeScript) -- this is an internal planning tool for a small trusted
 * team, not a public-facing form; a wildly out-of-range value is a planner
 * mistake to catch operationally (the generated plan's own Plan Warnings
 * will immediately show the consequence), not something this route needs
 * to police.
 */
export async function PUT(req: Request) {
  const supabase = getSupabaseServerClient();
  let body: { laborRules?: Partial<EditableRuleValues>; effectiveFrom?: string; fatigue?: FatigueConfig };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  try {
    if (body.laborRules) await saveLaborRuleEdit(supabase, body.laborRules, body.effectiveFrom);
    if (body.fatigue) await saveFatigueConfig(supabase, body.fatigue);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  // The write itself succeeded at this point -- but this reload (like GET
  // above) can still throw its own genuine Supabase error, and that must
  // not escape as an uncaught, non-JSON 500 either.
  try {
    const [rules, fatigue] = await Promise.all([loadLaborRules(supabase), loadFatigueConfig(supabase)]);
    const resolved = resolveDefaultLaborRules(undefined, rules);
    return NextResponse.json({ resolved, severity: LABOR_RULE_SEVERITY, fatigue }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
