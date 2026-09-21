import { SupabaseClient } from "@supabase/supabase-js";
import {
  Employee,
  Flight,
  Config,
  StaffingRequirement,
  WeeklyPlan,
  WeeklyPlanRosterEntry,
  Assignment,
  AssignmentModification,
  ZoneCheckinRequirement,
  ZoneCheckinAssignment,
} from "../types";
import { generateDraftWeeklyPlan } from "./generate-draft-plan";
import { computeWeeklyStaffingRequirements } from "./weekly-requirements";
import { buildPersistedWeeklyPlanView, PersistedWeeklyPlanView } from "./persisted-plan-view";
import { PriorDayShiftMap } from "./shift-generation";
import { deriveFallbackBoundaryContext, deriveTransitionContextFromPriorPlan, previousWeekStart } from "./rotation-context";
import { CheckinZoneId } from "../checkin-zones";

/**
 * Keeps `staffing_requirements` in sync with the flight set a plan is
 * about to be generated against. `buildDraftPlanBundle` (via
 * generateDraftWeeklyPlan) recomputes requirements -- and the deterministic
 * `req-<flightId>-<role>` ids every generated Assignment references -- purely
 * in memory; it was never the thing that persisted them. Historically the
 * only writer of this table was `resetDatabase` (lib/reset-database.ts),
 * which happened to seed `flights` and `staffing_requirements` from the
 * same in-memory list at the same moment -- so the ids always matched by
 * coincidence of timing, not because anything kept them in sync. The
 * moment a flight is added, edited, or imported (this milestone's real
 * capability) and Make Planning/Regenerate runs, the new flight's
 * requirement ids were never inserted here, and the `assignments` insert
 * that follows fails `assignments_staffing_requirement_id_fkey` -- exactly
 * the live failure this fixes. Upserted (never insert-only) on `id` so an
 * Edit Flight that changes a requirement's derivation (e.g. destination
 * reclassified) updates the existing row instead of conflicting with it;
 * a Remove Flight's now-orphaned rows are handled by the table's own
 * `flight_id` FK (`on delete cascade`), not by anything here.
 */
async function persistStaffingRequirementsForFlights(supabase: SupabaseClient, flights: Flight[], config: Config): Promise<StaffingRequirement[]> {
  const requirements = computeWeeklyStaffingRequirements(flights, config);
  if (requirements.length > 0) {
    const { error } = await supabase.from("staffing_requirements").upsert(requirements, { onConflict: "id" });
    if (error) throw new Error(`Persisting staffing requirements failed: ${error.message}`);
  }
  return requirements;
}

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
 * Sorts object keys recursively (arrays keep their element order, only
 * each object's own key order is normalized) so JSON.stringify never
 * varies with incidental key-insertion order -- a defensive companion to
 * the row-order fix below, not itself the live bug.
 */
function canonicalizeKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeKeyOrder);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = canonicalizeKeyOrder(record[key]);
    return sorted;
  }
  return value;
}

/**
 * Deterministic, dependency-free content hash (FNV-1a, 32-bit) of the
 * facts a plan revision was generated from. Used ONLY to DETECT that the
 * underlying flights/employees/config have changed since a draft was
 * generated (see WeeklyPlan.generated_from_hash's doc comment in
 * lib/types.ts) -- never a cryptographic guarantee, and this milestone
 * does not yet act on a mismatch beyond making it visible.
 *
 * `flights` and `employees` are both fetched with a plain
 * `.select("*")` and NO `.order(...)` at every call site that feeds this
 * function (both the generation path in this file and the isStale check
 * in app/api/planning/weekly-view/route.ts) -- Postgres makes no row-
 * order guarantee for a query without an explicit ORDER BY, so the same
 * logical rows can legitimately come back in a different physical order
 * on two separate calls. Hashing the raw JSON.stringify of an ordering-
 * sensitive array made that a false positive: an unordered re-fetch of
 * byte-identical data could hash differently and flip `isStale` to true
 * with nothing having actually changed (confirmed live immediately after
 * a fresh Make Planning run). Both collections are logically unordered
 * SETS of rows keyed by `id`, so they're sorted by `id` before hashing --
 * this is the actual fix. `config` is a single object, not a collection,
 * so it needs no reordering.
 */
export function hashPlanInputs(flights: Flight[], employees: Employee[], config: Config): string {
  const canonicalFlights = [...flights].sort((a, b) => a.id.localeCompare(b.id));
  const canonicalEmployees = [...employees].sort((a, b) => a.id.localeCompare(b.id));
  const payload = JSON.stringify(canonicalizeKeyOrder({ flights: canonicalFlights, employees: canonicalEmployees, config }));
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
  // T1 Check-in ZONE model (2026-09-21 cutover) -- PARALLEL rows, never
  // merged into `assignments`/`requirements` above (see
  // supabase/migrations/0015_checkin_zones.sql's doc comment).
  // `zoneRequirements` is DEMAND (one row per contiguous zone/day demand
  // cluster); `zoneAssignments` is DEFAULT PLACEMENT, one row per employee
  // per free interval, source "atlas_generated" -- both distinct from a
  // human_modified Find Agent zone-gap fill (see the zone-candidates/
  // zone-assign API routes).
  zoneRequirements: ZoneCheckinRequirement[];
  zoneAssignments: ZoneCheckinAssignment[];
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

  // T1 Check-in ZONE model (2026-09-21 cutover) -- deterministic ids
  // mirror the existing `req-<flightId>-<role>`/`assign-<planId>-...`
  // convention: `zonereq-<planId>-<day>-<zone>-<index>` (index is this
  // day+zone's own cluster/synthesized-row order, stable across a
  // byte-identical regeneration) and
  // `zoneassign-<planId>-<zoneRequirementId>-<employeeId>`.
  const zoneRequirements: ZoneCheckinRequirement[] = [];
  const zoneRequirementIdByDayZoneWindow = new Map<string, string>();
  for (const day of daysOrder) {
    const perZoneIndex = new Map<CheckinZoneId | string, number>();
    for (const r of draft.zoneRequirementsByDay[day] ?? []) {
      const index = perZoneIndex.get(r.zone) ?? 0;
      perZoneIndex.set(r.zone, index + 1);
      const id = `zonereq-${planId}-${day}-${r.zone}-${index}`;
      zoneRequirements.push({
        id,
        plan_id: planId,
        zone: r.zone,
        day_of_week: r.day_of_week,
        window_start: r.window_start,
        window_end: r.window_end,
        required_headcount: r.required_headcount,
        source: r.source,
        reasoning: r.reasoning,
        contributingFlightIds: r.contributingFlightIds,
      });
      zoneRequirementIdByDayZoneWindow.set(`${day}|${r.zone}|${r.window_start}|${r.window_end}`, id);
    }
  }

  function findZoneRequirementIdFor(day: string, zone: CheckinZoneId, window: { start: string; end: string }): string {
    // Placement duties are matched back to the zone requirement row
    // generate-draft-plan.ts already guaranteed exists for this exact
    // window (either a real demand cluster or the zero-headcount
    // "coverage-only" synthesized row -- see that file's own comment) --
    // this never needs to create a row itself, only look one up.
    const direct = zoneRequirementIdByDayZoneWindow.get(`${day}|${zone}|${window.start}|${window.end}`);
    if (direct) return direct;
    // Fallback: an overlapping (not necessarily identical) window, for
    // robustness against a future change to the overlap-matching logic in
    // generate-draft-plan.ts -- picks the first requirement row for this
    // day/zone that overlaps at all.
    const candidate = zoneRequirements.find((r) => r.plan_id === planId && r.day_of_week === day && r.zone === zone);
    if (!candidate) {
      throw new Error(
        `No checkin_zone_requirements row found for ${zone} on ${day} at ${window.start}-${window.end} -- generate-draft-plan.ts should have guaranteed one exists for every placement duty's window.`
      );
    }
    return candidate.id;
  }

  const allZoneDuties = Object.values(draft.zoneDutiesByDay).flat();
  const zoneAssignments: ZoneCheckinAssignment[] = allZoneDuties.map((d) => {
    const zoneRequirementId = findZoneRequirementIdFor(d.dayOfWeek, d.zone, d.window);
    // Suffixed with the placement window (colons stripped) rather than
    // just <zoneRequirementId>-<employeeId> -- an employee can have TWO
    // separate free intervals on the same day that both happen to fall
    // under the same zone requirement row (e.g. two short gaps either
    // side of a lunch-hour duty, both inside one wide demand cluster);
    // without this suffix those would collide on the same id.
    const windowSuffix = `${d.window.start}-${d.window.end}`.replace(/:/g, "");
    return {
      id: `zoneassign-${planId}-${zoneRequirementId}-${d.employeeId}-${windowSuffix}`,
      plan_id: planId,
      zone_requirement_id: zoneRequirementId,
      employee_id: d.employeeId,
      source: "atlas_generated",
      created_by: null,
      assigned_at: draft.generatedAt,
    };
  });

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

  return { plan, rosterEntries, assignments, zoneRequirements, zoneAssignments, summary };
}

/**
 * Persists the T1 Check-in ZONE rows (checkin_zone_requirements, its real
 * join table checkin_zone_requirement_contributing_flights, and
 * checkin_zone_assignments) -- shared by persistDraftPlanBundle and
 * regenerateDraftPlan below, exactly like every other table in this file.
 * `contributingFlightIds` lives on ZoneCheckinRequirement in memory but is
 * NOT a column on checkin_zone_requirements itself (see the migration) --
 * it's split out into its own join-table rows here, never sent as a
 * nested/JSON column.
 */
async function persistZoneRequirementsAndAssignments(
  supabase: SupabaseClient,
  zoneRequirements: ZoneCheckinRequirement[],
  zoneAssignments: ZoneCheckinAssignment[]
): Promise<void> {
  if (zoneRequirements.length > 0) {
    const rows = zoneRequirements.map(({ contributingFlightIds, ...row }) => row);
    const { error } = await supabase.from("checkin_zone_requirements").insert(rows);
    if (error) throw new Error(`Persisting checkin zone requirements failed: ${error.message}`);

    const joinRows = zoneRequirements.flatMap((r) => r.contributingFlightIds.map((flight_id) => ({ zone_requirement_id: r.id, flight_id })));
    if (joinRows.length > 0) {
      const { error: joinErr } = await supabase.from("checkin_zone_requirement_contributing_flights").insert(joinRows);
      if (joinErr) throw new Error(`Persisting checkin zone requirement contributing flights failed: ${joinErr.message}`);
    }
  }

  if (zoneAssignments.length > 0) {
    const { error } = await supabase.from("checkin_zone_assignments").insert(zoneAssignments);
    if (error) throw new Error(`Persisting checkin zone assignments failed: ${error.message}`);
  }
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

  await persistZoneRequirementsAndAssignments(supabase, bundle.zoneRequirements, bundle.zoneAssignments);

  // See verifyPlanPersisted's doc comment: a client library reporting no
  // `error` is NOT proof the write is actually visible to the very next
  // read (a silently-filtering RLS policy on the read/write path, a
  // schema-cache/connection-pooling quirk, or any other infra-level gap
  // between "the client thinks this succeeded" and "the database will
  // hand this back" all look identical from here otherwise) -- verify by
  // reading it straight back, in the same request, before telling any
  // caller this plan exists.
  await verifyPlanPersisted(supabase, bundle, "persistDraftPlanBundle");
}

/**
 * Paginates past PostgREST's default 1000-row `.select()` cap -- see
 * fetchAllRosterEntriesForPlan's doc comment below for the full
 * explanation; this is the same pattern applied to `assignments` too, so
 * the verification step below (and any other assignments-count check)
 * can't be fooled by the exact same silent-truncation failure mode.
 */
export async function fetchAllAssignmentsForPlan(supabase: SupabaseClient, planId: string): Promise<Assignment[]> {
  const PAGE_SIZE = 1000;
  const all: Assignment[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase.from("assignments").select("*").eq("plan_id", planId).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Fetching plan assignments failed: ${error.message}`);
    const page = (data ?? []) as Assignment[];
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

/**
 * READ-YOUR-OWN-WRITE verification, run at the end of every operation
 * that persists a plan revision (persistDraftPlanBundle above and
 * regenerateDraftPlan's own update+replace below). This is the direct fix
 * for the read-after-write bug traced in this milestone: Make Planning
 * was reporting a persisted revision (e.g. 2) that a client library call
 * had returned no `error` for, while the very next read of the SAME row
 * -- through the SAME service-role client, moments later -- still showed
 * the previous revision (1), with the previous revision's roster/
 * assignment rows still in place underneath it. The three most likely
 * causes for a Postgres UPDATE/DELETE+INSERT sequence to silently not
 * "take" while returning no client-visible error are: (1) a Row Level
 * Security USING policy on weekly_plans/weekly_plan_roster_entries/
 * assignments that silently filters the UPDATE/DELETE to zero affected
 * rows -- Postgres does NOT error on an UPDATE/DELETE that matches zero
 * rows, RLS-filtered or otherwise; (2) two logically "the same" plan
 * existing as two distinct rows (mismatched `id` from an earlier code
 * path, a migration that didn't enforce the primary key it declares, or
 * similar); (3) the write and the subsequent read genuinely landing on
 * different underlying data stores/connections. This function can't
 * distinguish which of those it is from inside the app -- what it CAN do
 * is refuse to report success for a revision that a same-process,
 * immediate re-read does not actually confirm, which is the honest
 * behavior "silently trust the insert/update call's own reported success"
 * was missing. A failure here surfaces as a hard 500 from the Make
 * Planning endpoint -- exactly what should happen instead of a plan
 * lifecycle function claiming a revision is live when it demonstrably
 * is not.
 */
async function verifyPlanPersisted(
  supabase: SupabaseClient,
  bundle: DraftPlanBundle,
  calledFrom: string
): Promise<{ revision: number; rosterCount: number; assignmentCount: number }> {
  const planId = bundle.plan.id;

  const { data: rows, error: planErr } = await supabase.from("weekly_plans").select("*").eq("id", planId);
  if (planErr) throw new Error(`${calledFrom}: verifying persisted plan failed: ${planErr.message}`);
  const persisted = rows?.[0] as WeeklyPlan | undefined;
  if (!persisted) {
    throw new Error(
      `${calledFrom}: persistence verification failed for plan "${planId}" -- expected revision ${bundle.plan.revision} to exist immediately after writing it, but a fresh read found NO row at all. The insert/update reported no error, but the row is not actually visible to the very next read through this same client -- do not trust this write as committed.`
    );
  }
  if (persisted.revision !== bundle.plan.revision) {
    throw new Error(
      `${calledFrom}: persistence verification failed for plan "${planId}" -- expected revision ${bundle.plan.revision} to be committed, but a fresh read reports revision ${persisted.revision} instead. The write that should have advanced this plan to revision ${bundle.plan.revision} did not actually take effect (a Row Level Security policy silently filtering the UPDATE, a stale/duplicate row under this same id, or some other write-visibility gap are the likely causes -- this needs investigating against the actual database, not papered over here). Refusing to report success for a revision that was never really committed.`
    );
  }

  const persistedRoster = await fetchAllRosterEntriesForPlan(supabase, planId);
  if (persistedRoster.length !== bundle.rosterEntries.length) {
    throw new Error(
      `${calledFrom}: persistence verification failed for plan "${planId}" revision ${bundle.plan.revision} -- expected ${bundle.rosterEntries.length} roster entries, but a fresh read found ${persistedRoster.length}. ${
        persistedRoster.length > bundle.rosterEntries.length
          ? "MORE rows than expected means an earlier revision's roster entries were not actually deleted before this revision's rows were inserted -- the two revisions' data is now mixed in the same table."
          : "FEWER rows than expected means this revision's insert did not fully take effect."
      } Refusing to report success for a revision whose persisted roster does not match what was just generated.`
    );
  }

  const persistedAssignments = await fetchAllAssignmentsForPlan(supabase, planId);
  if (persistedAssignments.length !== bundle.assignments.length) {
    throw new Error(
      `${calledFrom}: persistence verification failed for plan "${planId}" revision ${bundle.plan.revision} -- expected ${bundle.assignments.length} assignments, but a fresh read found ${persistedAssignments.length}. ${
        persistedAssignments.length > bundle.assignments.length
          ? "MORE rows than expected means an earlier revision's assignments were not actually deleted before this revision's rows were inserted -- the two revisions' data is now mixed in the same table."
          : "FEWER rows than expected means this revision's insert did not fully take effect."
      } Refusing to report success for a revision whose persisted assignments do not match what was just generated.`
    );
  }

  return { revision: persisted.revision, rosterCount: persistedRoster.length, assignmentCount: persistedAssignments.length };
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
export type PlanLifecycleResult =
  | { plan: WeeklyPlan; summary?: PlanSummary }
  | { blocked: true; reason: string };

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
    supabase.from("flights").select("*").eq("week_start", weekStart),
    supabase.from("employees").select("*"),
  ]);
  if (flightsErr || empErr) throw new Error((flightsErr || empErr)!.message);

  const priorWeekBoundaryContext = await lookupPriorWeekBoundaryContext(
    supabase,
    weekStart,
    daysOrder,
    employees as Employee[]
  );

  await persistStaffingRequirementsForFlights(supabase, flights as Flight[], config);

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
    supabase.from("flights").select("*").eq("week_start", existing.week_start),
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

  // Zone assignments/requirements are wiped and re-inserted exactly like
  // assignments/roster entries above -- checkin_zone_assignments and
  // checkin_zone_requirement_contributing_flights both cascade-delete via
  // their FK to checkin_zone_requirements (see the migration), so deleting
  // the requirements row is sufficient to clear all three tables for this
  // plan.
  const { error: deleteZoneReqErr } = await supabase.from("checkin_zone_requirements").delete().eq("plan_id", planId);
  if (deleteZoneReqErr) throw new Error(deleteZoneReqErr.message);

  await persistStaffingRequirementsForFlights(supabase, flights as Flight[], config);

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

  await persistZoneRequirementsAndAssignments(supabase, bundle.zoneRequirements, bundle.zoneAssignments);

  // Read-your-own-write verification -- this is a permanent safety check,
  // independent of the (now removed) deployed-diagnostics investigation:
  // Postgres does not error on an UPDATE/DELETE that matches zero rows
  // (a silently-filtering RLS policy or a stale/duplicate row are the
  // classic causes), so this re-reads the plan and its roster/assignment
  // counts before this function is allowed to report success, and throws
  // a specific, diagnostic error the moment any of them disagrees with
  // what was just generated. See verifyPlanPersisted's own doc comment.
  await verifyPlanPersisted(supabase, bundle, "regenerateDraftPlan");

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

  // Flights are fetched FIRST and used to scope requirements, rather than
  // fetching both in the same parallel batch unscoped -- staffing_
  // requirements has no week_start column of its own (it only ever
  // belongs to a week via its flight_id), so "this week's requirements"
  // can only be computed as "requirements whose flight_id is one of this
  // week's flights", never independently. Fetching flights unscoped here
  // (as this used to do) is exactly the cross-week leakage this
  // milestone exists to close: two different weeks' flights, requirements,
  // and Agent Schedule/Flight Coverage entries must never mix.
  const { data: flights, error: flightErr } = await supabase.from("flights").select("*").eq("week_start", weekStart);
  if (flightErr) throw new Error(flightErr.message);
  const flightIds = (flights ?? []).map((f) => f.id);

  const [rosterEntries, { data: assignments, error: assignErr }, { data: requirements, error: reqErr }, { data: employees, error: empErr }] = await Promise.all([
    fetchAllRosterEntriesForPlan(supabase, planId),
    supabase.from("assignments").select("*").eq("plan_id", planId),
    flightIds.length > 0 ? supabase.from("staffing_requirements").select("*").in("flight_id", flightIds) : Promise.resolve({ data: [], error: null }),
    supabase.from("employees").select("*"),
  ]);
  if (assignErr || reqErr || empErr) {
    throw new Error((assignErr || reqErr || empErr)!.message);
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
