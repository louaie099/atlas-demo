import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { EMPLOYEES, FLIGHTS, CONFIG, DAYS_WITH_DATA } from "../lib/seed-data";
import {
  generateDraftPlan,
  regenerateDraftPlan,
  publishPlan,
  loadPersistedPlanView,
  planIdForWeek,
  hashPlanInputs,
} from "../lib/planning/weekly-plan-service";
import { Assignment, WeeklyPlan, WeeklyPlanRosterEntry, AssignmentModification } from "../lib/types";

/**
 * A capable-enough fake Supabase for the lifecycle service: unlike the
 * minimal insert/delete-all fake in seed-generation-e2e.test.ts, this one
 * supports .select("*").eq(...) (returning a filtered array, awaited
 * directly via a thenable) and .update(patch).eq(...)/.delete().eq(...),
 * which generateDraftPlan/regenerateDraftPlan/publishPlan genuinely need
 * to look up and mutate a specific plan by id. Still not a real
 * PostgREST client -- just enough of the chainable shape this service
 * actually calls.
 */
interface FakeRow {
  [key: string]: unknown;
}

class FakeQuery implements PromiseLike<{ data: FakeRow[]; error: null }> {
  constructor(private table: FakeTable, private filters: [string, unknown][] = []) {}

  private rangeBounds: [number, number] | null = null;

  eq(col: string, val: unknown): FakeQuery {
    return new FakeQuery(this.table, [...this.filters, [col, val]]);
  }

  // Mirrors supabase-js's .range(from, to): an inclusive slice, applied
  // after filtering -- real PostgREST behavior fetchAllRosterEntriesForPlan
  // (lib/planning/weekly-plan-service.ts) actually relies on to page past
  // the default 1000-row cap. Without this, the fake would silently return
  // every row from a single unbounded page and could never catch a
  // regression back to the plain, unpaginated .select("*") this replaced.
  range(from: number, to: number): FakeQuery {
    const next = new FakeQuery(this.table, this.filters);
    next.rangeBounds = [from, to];
    return next;
  }

  then<TResult1 = { data: FakeRow[]; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: FakeRow[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null
  ): PromiseLike<TResult1 | TResult2> {
    let rows = this.table.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v));
    if (this.rangeBounds) {
      const [from, to] = this.rangeBounds;
      rows = rows.slice(from, to + 1);
    } else {
      // Real PostgREST silently caps an unbounded select at its
      // db-max-rows default (1000) -- reproduce that here so a regression
      // back to a plain, unpaginated .select("*") on a table that can
      // exceed it (weekly_plan_roster_entries, at real seed-data scale)
      // fails a test instead of only failing in production.
      rows = rows.slice(0, 1000);
    }
    return Promise.resolve({ data: rows, error: null }).then(onfulfilled as any);
  }
}

class FakeTable {
  rows: FakeRow[] = [];

  insert(records: FakeRow | FakeRow[]) {
    const arr = Array.isArray(records) ? records : [records];
    this.rows.push(...arr);
    return Promise.resolve({ data: arr, error: null });
  }

  select(_cols: string): FakeQuery {
    return new FakeQuery(this);
  }

  update(patch: FakeRow) {
    return {
      eq: (col: string, val: unknown) => {
        this.rows = this.rows.map((r) => (r[col] === val ? { ...r, ...patch } : r));
        return Promise.resolve({ error: null });
      },
    };
  }

  delete() {
    return {
      // Matches the existing minimal fake's semantics elsewhere: neq is
      // used only for "wipe the whole table" (id != "") in this codebase.
      neq: (_col: string, _val: unknown) => {
        this.rows = [];
        return Promise.resolve({ error: null });
      },
      eq: (col: string, val: unknown) => {
        this.rows = this.rows.filter((r) => r[col] !== val);
        return Promise.resolve({ error: null });
      },
    };
  }
}

class FakeSupabase {
  private tables = new Map<string, FakeTable>();

  from(name: string): any {
    if (!this.tables.get(name)) this.tables.set(name, new FakeTable());
    return this.tables.get(name)!;
  }

  table(name: string): FakeRow[] {
    return this.tables.get(name)?.rows ?? [];
  }

  seedFacts() {
    this.from("employees").insert(EMPLOYEES as unknown as FakeRow[]);
    this.from("flights").insert(FLIGHTS as unknown as FakeRow[]);
  }
}

const WEEK_START = "2026-09-01";
const WEEK_LABEL = "Test Week";

describe("weekly-plan-service — Generate Draft", () => {
  it("creates and persists a WeeklyPlan, its full roster, and every generated duty as a real atlas_generated Assignment row", async () => {
    const fake = new FakeSupabase();
    fake.seedFacts();

    const result = await generateDraftPlan(fake as unknown as SupabaseClient, WEEK_START, WEEK_LABEL, DAYS_WITH_DATA, CONFIG);
    expect("blocked" in result).toBe(false);
    if ("blocked" in result) throw new Error("unreachable");

    const plan = result.plan;
    expect(plan.id).toBe(planIdForWeek(WEEK_START));
    expect(plan.status).toBe("draft");
    expect(plan.revision).toBe(1);
    expect(plan.published_at).toBeNull();
    expect(plan.generated_from_hash).toBe(hashPlanInputs(FLIGHTS, EMPLOYEES, CONFIG));

    const persistedPlans = fake.table("weekly_plans");
    expect(persistedPlans).toHaveLength(1);

    const rosterEntries = fake.table("weekly_plan_roster_entries") as unknown as WeeklyPlanRosterEntry[];
    expect(rosterEntries.length).toBe(EMPLOYEES.length * DAYS_WITH_DATA.length);
    expect(rosterEntries.every((r) => r.plan_id === plan.id)).toBe(true);

    const assignments = fake.table("assignments") as unknown as Assignment[];
    expect(assignments.length).toBeGreaterThan(0);
    expect(assignments.every((a) => a.plan_id === plan.id && a.source === "atlas_generated" && a.created_by === null)).toBe(true);
  });

  it("is blocked (never silently overwrites) if a plan already exists for the week", async () => {
    const fake = new FakeSupabase();
    fake.seedFacts();

    await generateDraftPlan(fake as unknown as SupabaseClient, WEEK_START, WEEK_LABEL, DAYS_WITH_DATA, CONFIG);
    const second = await generateDraftPlan(fake as unknown as SupabaseClient, WEEK_START, WEEK_LABEL, DAYS_WITH_DATA, CONFIG);

    expect("blocked" in second).toBe(true);
    if (!("blocked" in second)) throw new Error("unreachable");
    expect(second.reason).toMatch(/already exists/);
    // Still exactly one plan row -- the blocked call inserted nothing.
    expect(fake.table("weekly_plans")).toHaveLength(1);
  });
});

describe("weekly-plan-service — Regenerate Draft", () => {
  async function setupDraft() {
    const fake = new FakeSupabase();
    fake.seedFacts();
    const result = await generateDraftPlan(fake as unknown as SupabaseClient, WEEK_START, WEEK_LABEL, DAYS_WITH_DATA, CONFIG);
    if ("blocked" in result) throw new Error("setup failed");
    return { fake, planId: result.plan.id };
  }

  it("replaces the draft's roster/assignments and increments revision when no human modification exists", async () => {
    const { fake, planId } = await setupDraft();
    const firstAssignmentIds = (fake.table("assignments") as unknown as Assignment[]).map((a) => a.id).sort();

    const result = await regenerateDraftPlan(fake as unknown as SupabaseClient, planId, DAYS_WITH_DATA, CONFIG);
    expect("blocked" in result).toBe(false);
    if ("blocked" in result) throw new Error("unreachable");

    expect(result.plan.revision).toBe(2);
    expect(result.plan.id).toBe(planId); // same identity, not a new plan
    expect(fake.table("weekly_plans")).toHaveLength(1); // updated in place, not duplicated

    const secondAssignmentIds = (fake.table("assignments") as unknown as Assignment[]).map((a) => a.id).sort();
    // Deterministic generation from the same facts reproduces the exact
    // same assignment id set -- this asserts the OLD rows were genuinely
    // replaced (deleted + reinserted), not merely appended to.
    expect(secondAssignmentIds).toEqual(firstAssignmentIds);
  });

  it("is blocked, with the exact required message, when the draft carries a human modification for its current revision", async () => {
    const { fake, planId } = await setupDraft();

    fake.from("assignment_modifications").insert({
      id: "mod-1",
      plan_id: planId,
      plan_revision: 1,
      staffing_requirement_id: "some-requirement",
      action: "added",
      previous_employee_id: null,
      new_employee_id: "some-employee",
      changed_by: "Mohammed Alaoui",
      changed_at: new Date().toISOString(),
      reason: null,
    } satisfies AssignmentModification);

    const result = await regenerateDraftPlan(fake as unknown as SupabaseClient, planId, DAYS_WITH_DATA, CONFIG);
    expect("blocked" in result).toBe(true);
    if (!("blocked" in result)) throw new Error("unreachable");
    expect(result.reason).toBe("This draft contains manual modifications and cannot be regenerated without discarding them.");

    // Nothing was touched -- still revision 1, no rows deleted.
    const plans = fake.table("weekly_plans") as unknown as WeeklyPlan[];
    expect(plans[0].revision).toBe(1);
  });

  it("is blocked once the plan has been published", async () => {
    const { fake, planId } = await setupDraft();
    await publishPlan(fake as unknown as SupabaseClient, planId);

    const result = await regenerateDraftPlan(fake as unknown as SupabaseClient, planId, DAYS_WITH_DATA, CONFIG);
    expect("blocked" in result).toBe(true);
    if (!("blocked" in result)) throw new Error("unreachable");
    expect(result.reason).toMatch(/already published/);
  });
});

describe("weekly-plan-service — Publish", () => {
  it("flips status to published and sets published_at, without touching any roster/assignment row", async () => {
    const fake = new FakeSupabase();
    fake.seedFacts();
    const draft = await generateDraftPlan(fake as unknown as SupabaseClient, WEEK_START, WEEK_LABEL, DAYS_WITH_DATA, CONFIG);
    if ("blocked" in draft) throw new Error("setup failed");

    const assignmentsBefore = (fake.table("assignments") as unknown as Assignment[]).map((a) => a.id).sort();
    const rosterBefore = (fake.table("weekly_plan_roster_entries") as unknown as WeeklyPlanRosterEntry[]).length;

    const result = await publishPlan(fake as unknown as SupabaseClient, draft.plan.id);
    expect("blocked" in result).toBe(false);
    if ("blocked" in result) throw new Error("unreachable");
    expect(result.plan.status).toBe("published");
    expect(result.plan.published_at).not.toBeNull();

    const assignmentsAfter = (fake.table("assignments") as unknown as Assignment[]).map((a) => a.id).sort();
    const rosterAfter = (fake.table("weekly_plan_roster_entries") as unknown as WeeklyPlanRosterEntry[]).length;
    expect(assignmentsAfter).toEqual(assignmentsBefore); // Publish does not generate/touch assignments
    expect(rosterAfter).toBe(rosterBefore);
  });

  it("is blocked when the plan is already published", async () => {
    const fake = new FakeSupabase();
    fake.seedFacts();
    const draft = await generateDraftPlan(fake as unknown as SupabaseClient, WEEK_START, WEEK_LABEL, DAYS_WITH_DATA, CONFIG);
    if ("blocked" in draft) throw new Error("setup failed");

    await publishPlan(fake as unknown as SupabaseClient, draft.plan.id);
    const second = await publishPlan(fake as unknown as SupabaseClient, draft.plan.id);
    expect("blocked" in second).toBe(true);
    if (!("blocked" in second)) throw new Error("unreachable");
    expect(second.reason).toMatch(/already published/);
  });
});

describe("weekly-plan-service — loadPersistedPlanView", () => {
  it("returns null when no plan has been generated yet for the week -- never falls back to a live computation", async () => {
    const fake = new FakeSupabase();
    fake.seedFacts();
    const view = await loadPersistedPlanView(fake as unknown as SupabaseClient, WEEK_START, DAYS_WITH_DATA);
    expect(view).toBeNull();
  });

  it("reads back the exact persisted plan/roster/assignments after Generate Draft, with no recomputation", async () => {
    const fake = new FakeSupabase();
    fake.seedFacts();
    const draft = await generateDraftPlan(fake as unknown as SupabaseClient, WEEK_START, WEEK_LABEL, DAYS_WITH_DATA, CONFIG);
    if ("blocked" in draft) throw new Error("setup failed");

    // computeWeeklyStaffingRequirements output must also exist for the
    // view builder to resolve requirement/flight context -- seed it the
    // same way resetDatabase does.
    const { computeWeeklyStaffingRequirements } = await import("../lib/planning/weekly-requirements");
    const requirements = computeWeeklyStaffingRequirements(FLIGHTS, CONFIG);
    fake.from("staffing_requirements").insert(requirements as unknown as FakeRow[]);

    const view = await loadPersistedPlanView(fake as unknown as SupabaseClient, WEEK_START, DAYS_WITH_DATA);
    expect(view).not.toBeNull();
    expect(view!.plan.id).toBe(draft.plan.id);
    expect(view!.roster.length).toBeGreaterThan(0);
    expect(view!.schedule.length).toBeGreaterThan(0);
    // Every duty ATLAS generated shows in the "proposed" bucket -- a real,
    // persisted, atlas_generated row, never a pending recommendation.
    const anyProposed = view!.roster.some((r) => r.proposedEmployees.length > 0);
    expect(anyProposed).toBe(true);

    // Regression guard for the 1000-row PostgREST select cap: the real
    // EMPLOYEES seed (~206 people) * 7 days is ~1442 roster rows, which
    // crosses that cap, and rows are inserted day-major (every employee
    // for Monday, then Tuesday, ... Sunday) -- so a truncated, unpaginated
    // fetch drops Saturday/Sunday (and the tail of Friday) first, and
    // drops the LAST-generated employees within a day first. If
    // loadPersistedPlanView ever regresses to a plain, unpaginated
    // .select("*") instead of fetchAllRosterEntriesForPlan, this is what
    // catches it: every employee must have a real, resolved Sunday entry,
    // not a phantom "no roster row -> displayed as off."
    expect(view!.schedule.length).toBeGreaterThan(0);
    for (const entry of view!.schedule) {
      const sunday = entry.days.find((d) => d.dayOfWeek === "Sunday");
      expect(sunday).toBeDefined();
    }
    // The specific employee most likely to land past row 1000 in
    // insertion order (last in the seed array, i.e. the last-generated
    // group) must resolve to a genuine, non-default Sunday status --
    // never silently coerced to "off" by a missing row.
    const lastEmployee = EMPLOYEES[EMPLOYEES.length - 1];
    const lastEntry = view!.schedule.find((e) => e.employee.id === lastEmployee.id);
    expect(lastEntry).toBeDefined();
    const lastSunday = lastEntry!.days.find((d) => d.dayOfWeek === "Sunday")!;
    const expectedSunday = lastEmployee.weekly_shifts.find((s) => s.day_of_week === "Sunday")!;
    expect(lastSunday.status).toBe(expectedSunday.status);
  });
});
