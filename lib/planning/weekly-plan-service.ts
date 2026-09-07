import { SupabaseClient } from "@supabase/supabase-js";
import { Employee, Flight, Config, StaffingRequirement, WeeklyPlan, WeeklyPlanRosterEntry, Assignment, AssignmentModification } from "../types";
import { generateDraftWeeklyPlan } from "./generate-draft-plan";
import { buildPersistedWeeklyPlanView, PersistedWeeklyPlanView } from "./persisted-plan-view";

/**
 * The Weekly Plan lifecycle service. This is the ONLY place that creates,
 * regenerates, or publishes a WeeklyPlan -- every caller (the
 * generate-draft/regenerate-draft/publish API routes, AND
 * lib/reset-database.ts) goes through the exact same functions here, so
 * there is exactly one "what does generating a draft actually do"
 * implementation, never a second seed-only one.
 *
 * generateDraftWeeklyPlan itself (lib/planning/generate-draft-plan.ts) is
 * UNCHANGED -- still the documented greedy, per-day/departure-order
 * algorithm (see its own module comments and duty-generation.ts's). This
 * service only decides WHEN that computation runs and WHAT becomes
 * durable from its output; a future global assignment solver replaces
 * generateDraftWeeklyPlan's internals without this file, or the schema it
 * writes to, needing to change.
 */

export function planIdForWeek(weekStart: string): string {
  return `plan-${weekStart}`;
}

/**
 * Deterministic, dependency-free content hash (FNV-1a, 32-bit) of the
 * facts a plan revision was generated from. Used ONLY to DETECT that the
 * underlying flights/employees/config have changed since a draft was
 * generated (see WeeklyPlan.generated_from_hash's doc comment in
 * lib/types.ts) -- never a cryptographic guarantee, and this milestone
 * does not yet act on a mismatch beyond making it visible.
 */
export function hashPlanInputs(flights: Flight[], employees: Employee[], config: Config): string {
  const payload = JSON.stringify({ flights, employees, config });
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

export interface DraftPlanBundle {
  plan: WeeklyPlan;
  rosterEntries: WeeklyPlanRosterEntry[];
  assignments: Assignment[];
}

export interface BuildDraftPlanBundleInput {
  planId: string;
  weekStart: string;
  weekLabel: string;
  revision: number;
  flights: Flight[];
  employees: Employee[];
  config: Config;
  daysOrder: string[];
}

/**
 * Pure computation, no I/O: runs the existing generation pipeline against
 * a completely empty existing-assignments set (a draft is generated from
 * scratch every time -- Regenerate replaces the whole thing, it never
 * merges) and reshapes the result into the durable rows a WeeklyPlan owns.
 * Every normal duty the engine produces becomes a real `assignments` row
 * with `source: "atlas_generated"` immediately -- these are ATLAS's actual
 * assignments inside this draft, never a pending recommendation (see
 * lib/types.ts's Assignment.source doc comment).
 */
export function buildDraftPlanBundle(input: BuildDraftPlanBundleInput): DraftPlanBundle {
  const { planId, weekStart, weekLabel, revision, flights, employees, config, daysOrder } = input;
  const draft = generateDraftWeeklyPlan(flights, employees, [], config, daysOrder, weekLabel);

  const plan: WeeklyPlan = {
    id: planId,
    week_start: weekStart,
    week_label: weekLabel,
    status: "draft",
    revision,
    generated_at: draft.generatedAt,
    published_at: null,
    generated_from_hash: hashPlanInputs(flights, employees, config),
    config_snapshot: config,
    issues: draft.issues,
    configuration_issues: draft.configurationIssues,
  };

  const rosterEntries: WeeklyPlanRosterEntry[] = draft.rosterEntries.map((r) => ({
    id: `roster-${planId}-${r.employee_id}-${r.day_of_week}`,
    plan_id: planId,
    employee_id: r.employee_id,
    day_of_week: r.day_of_week,
    status: r.status,
    shift_code: r.shift_code,
  }));

  const allDuties = Object.values(draft.dutiesByDay).flat();
  const assignments: Assignment[] = allDuties.map((d) => ({
    id: `assign-${planId}-${d.requirementId}-${d.employeeId}`,
    plan_id: planId,
    staffing_requirement_id: d.requirementId,
    employee_id: d.employeeId,
    source: "atlas_generated",
    created_by: null,
    assigned_at: draft.generatedAt,
  }));

  return { plan, rosterEntries, assignments };
}

/** The actual I/O for a freshly-built bundle -- shared by generateDraftPlan below AND lib/reset-database.ts, so Reset Demo persists through this exact same step, never a parallel insert path. */
export async function persistDraftPlanBundle(supabase: SupabaseClient, bundle: DraftPlanBundle): Promise<void> {
  const { error: planErr } = await supabase.from("weekly_plans").insert(bundle.plan);
  if (planErr) throw new Error(`Persisting weekly plan failed: ${planErr.message}`);

  if (bundle.rosterEntries.length > 0) {
    const { error: rosterErr } = await supabase.from("weekly_plan_roster_entries").insert(bundle.rosterEntries);
    if (rosterErr) throw new Error(`Persisting plan roster entries failed: ${rosterErr.message}`);
  }

  if (bundle.assignments.length > 0) {
    const { error: assignErr } = await supabase.from("assignments").insert(bundle.assignments);
    if (assignErr) throw new Error(`Persisting plan assignments failed: ${assignErr.message}`);
  }
}

export type PlanLifecycleResult = { plan: WeeklyPlan } | { blocked: true; reason: string };

/**
 * Generate Draft. Refuses (blocked, never silently overwrites) if a plan
 * already exists for this week -- Regenerate is the explicit, separate
 * operation for replacing an existing draft (see regenerateDraftPlan
 * below); this function only ever creates.
 */
export async function generateDraftPlan(
  supabase: SupabaseClient,
  weekStart: string,
  weekLabel: string,
  daysOrder: string[],
  config: Config
): Promise<PlanLifecycleResult> {
  const planId = planIdForWeek(weekStart);

  const { data: existing, error: existingErr } = await supabase.from("weekly_plans").select("*").eq("id", planId);
  if (existingErr) throw new Error(existingErr.message);
  if (existing && existing.length > 0) {
    return {
      blocked: true,
      reason: `A plan already exists for the week of ${weekStart} (status: ${(existing[0] as WeeklyPlan).status}). Use Regenerate to replace a draft, or Publish it.`,
    };
  }

  const [{ data: flights, error: flightsErr }, { data: employees, error: empErr }] = await Promise.all([
    supabase.from("flights").select("*"),
    supabase.from("employees").select("*"),
  ]);
  if (flightsErr || empErr) throw new Error((flightsErr || empErr)!.message);

  const bundle = buildDraftPlanBundle({
    planId,
    weekStart,
    weekLabel,
    revision: 1,
    flights: flights as Flight[],
    employees: employees as Employee[],
    config,
    daysOrder,
  });
  await persistDraftPlanBundle(supabase, bundle);

  return { plan: bundle.plan };
}

/**
 * Regenerate Draft. Blocked (never silently discards) when the draft
 * contains ANY human modification recorded against its CURRENT revision
 * -- "no silent loss, no pretending manual work survived when it did
 * not," per the confirmed correction. Blocked when the plan is not a
 * draft at all (a published plan is never regenerated by this path -- see
 * lib/types.ts's WeeklyPlan doc comment on publish immutability).
 */
export async function regenerateDraftPlan(
  supabase: SupabaseClient,
  planId: string,
  daysOrder: string[],
  config: Config
): Promise<PlanLifecycleResult> {
  const { data: rows, error: readErr } = await supabase.from("weekly_plans").select("*").eq("id", planId);
  if (readErr) throw new Error(readErr.message);
  const existing = rows?.[0] as WeeklyPlan | undefined;
  if (!existing) return { blocked: true, reason: `No plan found with id "${planId}".` };
  if (existing.status !== "draft") {
    return { blocked: true, reason: "Only a draft plan can be regenerated -- this plan is already published." };
  }

  const { data: mods, error: modsErr } = await supabase.from("assignment_modifications").select("*").eq("plan_id", planId);
  if (modsErr) throw new Error(modsErr.message);
  const modsThisRevision = ((mods ?? []) as AssignmentModification[]).filter((m) => m.plan_revision === existing.revision);
  if (modsThisRevision.length > 0) {
    return {
      blocked: true,
      reason: "This draft contains manual modifications and cannot be regenerated without discarding them.",
    };
  }

  const [{ data: flights, error: flightsErr }, { data: employees, error: empErr }] = await Promise.all([
    supabase.from("flights").select("*"),
    supabase.from("employees").select("*"),
  ]);
  if (flightsErr || empErr) throw new Error((flightsErr || empErr)!.message);

  // Wipe this plan's roster/assignments before re-inserting the new
  // revision's -- the plan row itself (id/week_start/status) is UPDATED,
  // never recreated, so its identity is stable across a regeneration.
  // AssignmentModification history rows are deliberately NOT deleted --
  // they stay attached to the plan id as a record of what was tried
  // before, even once the revision they applied to is gone (there are
  // none for the CURRENT revision at this point anyway, or we would have
  // blocked above).
  const { error: deleteAssignErr } = await supabase.from("assignments").delete().eq("plan_id", planId);
  if (deleteAssignErr) throw new Error(deleteAssignErr.message);
  const { error: deleteRosterErr } = await supabase.from("weekly_plan_roster_entries").delete().eq("plan_id", planId);
  if (deleteRosterErr) throw new Error(deleteRosterErr.message);

  const bundle = buildDraftPlanBundle({
    planId,
    weekStart: existing.week_start,
    weekLabel: existing.week_label,
    revision: existing.revision + 1,
    flights: flights as Flight[],
    employees: employees as Employee[],
    config,
    daysOrder,
  });

  const { error: updateErr } = await supabase
    .from("weekly_plans")
    .update({
      revision: bundle.plan.revision,
      generated_at: bundle.plan.generated_at,
      generated_from_hash: bundle.plan.generated_from_hash,
      config_snapshot: bundle.plan.config_snapshot,
      issues: bundle.plan.issues,
      configuration_issues: bundle.plan.configuration_issues,
    })
    .eq("id", planId);
  if (updateErr) throw new Error(`Updating weekly plan failed: ${updateErr.message}`);

  if (bundle.rosterEntries.length > 0) {
    const { error } = await supabase.from("weekly_plan_roster_entries").insert(bundle.rosterEntries);
    if (error) throw new Error(`Persisting plan roster entries failed: ${error.message}`);
  }
  if (bundle.assignments.length > 0) {
    const { error } = await supabase.from("assignments").insert(bundle.assignments);
    if (error) throw new Error(`Persisting plan assignments failed: ${error.message}`);
  }

  return { plan: { ...existing, ...bundle.plan } };
}

/**
 * Publish. Does NOT generate or touch any assignment/roster row -- they
 * already exist in the draft (see the module doc comment). This is a pure
 * status/timestamp flip. Once published, this same service refuses to
 * Regenerate it (see above); editing a published plan's assignments is
 * not exposed anywhere in this milestone (no route calls into it), which
 * is the honest way to leave room for a future operational-modification
 * layer without building it now.
 */
export async function publishPlan(supabase: SupabaseClient, planId: string): Promise<PlanLifecycleResult> {
  const { data: rows, error: readErr } = await supabase.from("weekly_plans").select("*").eq("id", planId);
  if (readErr) throw new Error(readErr.message);
  const existing = rows?.[0] as WeeklyPlan | undefined;
  if (!existing) return { blocked: true, reason: `No plan found with id "${planId}".` };
  if (existing.status !== "draft") {
    return { blocked: true, reason: "Only a draft plan can be published -- this plan is already published." };
  }

  const publishedAt = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from("weekly_plans")
    .update({ status: "published", published_at: publishedAt })
    .eq("id", planId);
  if (updateErr) throw new Error(`Publishing weekly plan failed: ${updateErr.message}`);

  return { plan: { ...existing, status: "published", published_at: publishedAt } };
}

/**
 * The single read path for an already-persisted plan -- every consumer
 * (weekly-view, roster, agent-schedule, the draft inspection route) goes
 * through this instead of independently fetching+assembling the same
 * rows. Returns null when no plan exists yet for this week (the caller
 * shows a "Generate Draft" state) -- this NEVER falls back to computing a
 * live plan; that would silently reintroduce "a refresh generates a new
 * conceptual plan," exactly what this milestone removes.
 */
export async function loadPersistedPlanView(
  supabase: SupabaseClient,
  weekStart: string,
  daysOrder: string[]
): Promise<PersistedWeeklyPlanView | null> {
  const planId = planIdForWeek(weekStart);
  const { data: rows, error: planErr } = await supabase.from("weekly_plans").select("*").eq("id", planId);
  if (planErr) throw new Error(planErr.message);
  const plan = rows?.[0] as WeeklyPlan | undefined;
  if (!plan) return null;

  const [
    { data: rosterEntries, error: rosterErr },
    { data: assignments, error: assignErr },
    { data: requirements, error: reqErr },
    { data: flights, error: flightErr },
    { data: employees, error: empErr },
  ] = await Promise.all([
    supabase.from("weekly_plan_roster_entries").select("*").eq("plan_id", planId),
    supabase.from("assignments").select("*").eq("plan_id", planId),
    supabase.from("staffing_requirements").select("*"),
    supabase.from("flights").select("*"),
    supabase.from("employees").select("*"),
  ]);
  if (rosterErr || assignErr || reqErr || flightErr || empErr) {
    throw new Error((rosterErr || assignErr || reqErr || flightErr || empErr)!.message);
  }

  return buildPersistedWeeklyPlanView(
    plan,
    rosterEntries as WeeklyPlanRosterEntry[],
    assignments as Assignment[],
    requirements as StaffingRequirement[],
    flights as Flight[],
    employees as Employee[],
    daysOrder
  );
}
