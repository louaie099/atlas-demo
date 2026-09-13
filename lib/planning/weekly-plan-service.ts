import { SupabaseClient } from "@supabase/supabase-js";
import { Employee, Flight, Config, StaffingRequirement, WeeklyPlan, WeeklyPlanRosterEntry, Assignment, AssignmentModification } from "../types";
import { generateDraftWeeklyPlan } from "./generate-draft-plan";
import { buildPersistedWeeklyPlanView, PersistedWeeklyPlanView } from "./persisted-plan-view";
import { PriorDayShiftMap } from "./shift-generation";
import { deriveFallbackBoundaryContext, deriveTransitionContextFromPriorPlan, previousWeekStart } from "./rotation-context";

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

/**
 * The concise, human-facing readout of one generation run -- what the
 * Make Planning button shows after it finishes (see
 * components/make-planning-button.tsx). Deliberately just four counts,
 * all derived from the SAME `draft` the persisted plan/roster/assignment
 * rows come from (buildDraftPlanBundle below) -- never a separate
 * recomputation that could disagree with what was actually persisted.
 * `hardRestViolations` is expected to always read 0: the whole point of
 * the hard rest gate (generate-draft-plan.ts's enforceRestInvariantAcrossWeek,
 * run for the flexible pool AND universally across every employee) is
 * that an illegal transition is dropped/blocked before it ever reaches
 * this summary, never persisted and then merely reported.
 */
export interface PlanSummary {
  managedFlights: number;
  dutiesAssigned: number;
  staffingGaps: number;
  // Non-blocking operational findings other than a plain staffing gap
  // (currently: weekly_hours_violation, consecutive_off_violation --
  // rest_violation is intentionally excluded here, since a persisted one
  // would be a hard violation, not a warning; see hardRestViolations).
  warnings: number;
  // Unresolved BLOCKING configuration/planning conflicts (a specialized
  // team's rotation or demand that couldn't be made to satisfy the
  // confirmed 15h minimum -- see generate-draft-plan.ts's
  // specializedRestConflictIssues/demandConflictIssues). Nonzero here
  // means the plan is real but INCOMPLETE, not unhealthy noise to hide --
  // see MakePlanningButton, which changes its own wording accordingly,
  // and publishPlan, which refuses to publish while this is nonzero.
  blockingConflicts: number;
  // Expected to always read 0 -- a real persisted rest_violation would
  // mean the generation-time hard gate itself failed, not a normal
  // outcome to report alongside a healthy plan.
  hardRestViolations: number;
}

export interface DraftPlanBundle {
  plan: WeeklyPlan;
  rosterEntries: WeeklyPlanRosterEntry[];
  assignments: Assignment[];
  summary: PlanSummary;
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
  // Cross-plan Sunday(week N)->Monday(week N+1) continuity seed (see
  // generateDraftWeeklyPlan's own parameter of the same name). Callers
  // that have already fetched the immediately preceding week's real
  // persisted roster (see generateDraftPlan/regenerateDraftPlan below,
  // which do that I/O) pass it here. Omitted -- e.g. the first-ever plan
  // for this population, or any caller that hasn't looked up a
  // predecessor -- falls back to deriveFallbackBoundaryContext, which is
  // still strictly better than an empty map (see that function's doc
  // comment): it is never correct to silently skip the Sunday->Monday
  // rest check just because no prior PLAN row happens to exist yet.
  priorWeekBoundaryContext?: PriorDayShiftMap;
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
  const priorWeekBoundaryContext =
    input.priorWeekBoundaryContext ?? deriveFallbackBoundaryContext(employees, daysOrder);
  const draft = generateDraftWeeklyPlan(flights, employees, [], config, daysOrder, weekLabel, priorWeekBoundaryContext);

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

  const summary: PlanSummary = {
    managedFlights: flights.filter((f) => f.operator_type === "atlas_managed").length,
    dutiesAssigned: assignments.length,
    staffingGaps: draft.issues.filter((i) => i.type === "unfilled_duty").length,
    warnings: draft.issues.filter((i) => i.type !== "unfilled_duty" && i.type !== "rest_violation").length,
    blockingConflicts: draft.configurationIssues.filter((c) => c.description.startsWith("BLOCKING:")).length,
    hardRestViolations: draft.issues.filter((i) => i.type === "rest_violation").length,
  };

  return { plan, rosterEntries, assignments, summary };
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

/**
 * Supabase/PostgREST caps a plain `.select()` at 1000 rows by default
 * (the `db-max-rows` setting) -- silently: no error, it just returns the
 * first page and stops. weekly_plan_roster_entries holds one row per
 * employee per day (7 * headcount), which crosses that cap well within
 * this project's current ~200-employee scale (7 * 200 = 1400), and every
 * consumer of this table treats "no row returned" as an implicit OFF (see
 * buildPersistedAgentScheduleEntries and buildDayEffectivePoolFromRosterEntries's
 * callers) -- so a silent truncation here doesn't error, it just makes
 * whichever employee/day rows fell past row 1000 look like unplanned days
 * off. Rows are inserted day-major (every employee for Monday, then every
 * employee for Tuesday, ...), so a truncation reliably eats the LAST days
 * of the week first and the LAST-generated employee groups within a day
 * first -- exactly the "everyone is off Saturday/Sunday, and it's worst
 * for the foreign-company teams" shape this was actually observed as.
 * This paginates with `.range()` until a page comes back short of a full
 * page, so the full table is read regardless of size.
 */
export async function fetchAllRosterEntriesForPlan(
  supabase: SupabaseClient,
  planId: string
): Promise<WeeklyPlanRosterEntry[]> {
  const PAGE_SIZE = 1000;
  const all: WeeklyPlanRosterEntry[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("weekly_plan_roster_entries")
      .select("*")
      .eq("plan_id", planId)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Fetching plan roster entries failed: ${error.message}`);
    const page = (data ?? []) as WeeklyPlanRosterEntry[];
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

// `summary` is optional: generateDraftPlan/regenerateDraftPlan (and
// makePlanning, which composes them) always provide it -- a real
// generation run happened, so there's something to summarize. publishPlan
// below shares this same result type (it's also a plan lifecycle
// transition) but is a pure status/timestamp flip with no generation
// step, so it has nothing to summarize and omits the field.
export type PlanLifecycleResult = { plan: WeeklyPlan; summary?: PlanSummary } | { blocked: true; reason: string };

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

  const priorWeekBoundaryContext = await lookupPriorWeekBoundaryContext(
    supabase,
    weekStart,
    daysOrder,
    employees as Employee[]
  );

  const bundle = buildDraftPlanBundle({
    planId,
    weekStart,
    weekLabel,
    revision: 1,
    flights: flights as Flight[],
    employees: employees as Employee[],
    config,
    daysOrder,
    priorWeekBoundaryContext,
  });
  await persistDraftPlanBundle(supabase, bundle);

  return { plan: bundle.plan, summary: bundle.summary };
}

/**
 * Looks up the immediately preceding calendar week's WeeklyPlan (if one
 * was ever generated and persisted) and, when found, derives the real
 * Sunday(week N) -> Monday(week N+1) continuity seed from its actual last
 * displayed day's roster (see rotation-context.ts). Returns undefined
 * when no predecessor plan exists -- buildDraftPlanBundle then falls back
 * to deriveFallbackBoundaryContext on its own, so this never leaves the
 * boundary check silently empty either way (see that function's doc
 * comment).
 *
 * This deliberately only looks ONE week back -- exactly the "minimum
 * state that must persist between weeks" the audit asked for, not a full
 * historical rotation-anchor system. A plan more than one week old is
 * never consulted.
 */
async function lookupPriorWeekBoundaryContext(
  supabase: SupabaseClient,
  weekStart: string,
  daysOrder: string[],
  employees: Employee[]
): Promise<PriorDayShiftMap | undefined> {
  const priorWeekId = planIdForWeek(previousWeekStart(weekStart));
  const { data: priorPlanRows, error: priorPlanErr } = await supabase
    .from("weekly_plans")
    .select("id")
    .eq("id", priorWeekId);
  if (priorPlanErr) throw new Error(priorPlanErr.message);
  if (!priorPlanRows || priorPlanRows.length === 0) return undefined;

  const priorRosterEntries = await fetchAllRosterEntriesForPlan(supabase, priorWeekId);
  const priorLastDay = daysOrder[daysOrder.length - 1];
  return deriveTransitionContextFromPriorPlan(employees, priorRosterEntries, priorLastDay);
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

  const priorWeekBoundaryContext = await lookupPriorWeekBoundaryContext(
    supabase,
    existing.week_start,
    daysOrder,
    employees as Employee[]
  );

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
    priorWeekBoundaryContext,
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

  return { plan: { ...existing, ...bundle.plan }, summary: bundle.summary };
}

/**
 * Make Planning — the single user-facing action behind the Weekly
 * Planning page's "Make Planning" button. This is deliberately NOT a
 * third generation implementation: it is a thin state-machine that picks
 * between the two lifecycle functions already above, based on what
 * currently exists for this week, so there is exactly one real answer to
 * "what does clicking Make Planning actually do":
 *
 *  - No plan exists yet for this week -> generateDraftPlan creates one
 *    from the CURRENT flight schedule/employees/config.
 *  - A draft exists with no human modification recorded against its
 *    current revision -> regenerateDraftPlan replaces it cleanly, running
 *    the full current pipeline (flight schedule -> requirements -> demand
 *    aggregation -> shift capacity -> roster -> duties -> hard rest
 *    validation) against the CURRENT inputs -- so a planner who changed
 *    the flight schedule and clicks Make Planning gets a plan that
 *    reflects it, never a stale cached one.
 *  - A draft exists WITH a human modification against its current
 *    revision -> regenerateDraftPlan's own existing guard blocks it
 *    (returns `blocked`, never silently discards the manual work).
 *  - The plan is already published -> regenerateDraftPlan's own existing
 *    guard blocks it too (a published plan is immutable via this path).
 *
 * A normal page load/refresh never calls this -- see
 * loadPersistedPlanView's own doc comment: reading the Weekly Planning
 * page only ever reads whatever was last persisted, it never runs the
 * pipeline. Only an explicit POST to /api/planning/make-planning (the
 * button click) can create or change a plan.
 */
export async function makePlanning(
  supabase: SupabaseClient,
  weekStart: string,
  weekLabel: string,
  daysOrder: string[],
  config: Config
): Promise<PlanLifecycleResult> {
  const planId = planIdForWeek(weekStart);
  const { data: rows, error } = await supabase.from("weekly_plans").select("*").eq("id", planId);
  if (error) throw new Error(error.message);
  const existing = rows?.[0] as WeeklyPlan | undefined;

  if (!existing) {
    return generateDraftPlan(supabase, weekStart, weekLabel, daysOrder, config);
  }
  return regenerateDraftPlan(supabase, planId, daysOrder, config);
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

  // Hard publish guard: a draft carrying an unresolved BLOCKING
  // configuration conflict (a specialized team's rotation or demand that
  // couldn't be made to satisfy the confirmed 15h minimum -- see
  // generate-draft-plan.ts) or an actual persisted rest_violation
  // (should never happen given the generation-time hard gate, but this is
  // the last checkpoint, not merely a repeat of an earlier one) must
  // never be published as if it were a healthy, operationally valid
  // plan. Ordinary unfilled_duty staffing gaps are NOT blocked here --
  // those may remain publishable depending on policy; only a confirmed
  // hard labor-rule or configuration conflict blocks publication.
  const blockingConfigurationIssues = existing.configuration_issues.filter((c) => c.description.startsWith("BLOCKING:"));
  const restViolations = existing.issues.filter((i) => i.type === "rest_violation");
  if (blockingConfigurationIssues.length > 0 || restViolations.length > 0) {
    const parts: string[] = [];
    if (blockingConfigurationIssues.length > 0) {
      parts.push(`${blockingConfigurationIssues.length} unresolved blocking configuration conflict(s)`);
    }
    if (restViolations.length > 0) {
      parts.push(`${restViolations.length} unresolved hard rest violation(s)`);
    }
    return {
      blocked: true,
      reason: `This draft cannot be published: it still has ${parts.join(" and ")}. Resolve them (or accept the plan is intentionally incomplete for now) before publishing -- staffing gaps alone would not block this, but a confirmed hard labor-rule or configuration conflict must be resolved first.`,
    };
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
    rosterEntries,
    { data: assignments, error: assignErr },
    { data: requirements, error: reqErr },
    { data: flights, error: flightErr },
    { data: employees, error: empErr },
  ] = await Promise.all([
    fetchAllRosterEntriesForPlan(supabase, planId),
    supabase.from("assignments").select("*").eq("plan_id", planId),
    supabase.from("staffing_requirements").select("*"),
    supabase.from("flights").select("*"),
    supabase.from("employees").select("*"),
  ]);
  if (assignErr || reqErr || flightErr || empErr) {
    throw new Error((assignErr || reqErr || flightErr || empErr)!.message);
  }

  return buildPersistedWeeklyPlanView(
    plan,
    rosterEntries,
    assignments as Assignment[],
    requirements as StaffingRequirement[],
    flights as Flight[],
    employees as Employee[],
    daysOrder
  );
}
