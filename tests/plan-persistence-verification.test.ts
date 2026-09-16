import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { EMPLOYEES, FLIGHTS, CONFIG, DAYS_WITH_DATA } from "../lib/seed-data";
import { generateDraftPlan, regenerateDraftPlan } from "../lib/planning/weekly-plan-service";
import { WeeklyPlan } from "../lib/types";

/**
 * Regression coverage for the traced read-after-write bug: Make Planning
 * reported a persisted revision (e.g. 2) that a client library call had
 * returned no `error` for, while the very next read of the SAME plan row
 * -- through the SAME service-role client, moments later -- still showed
 * the previous revision, with the previous revision's roster/assignment
 * rows still underneath it. Static tracing of every candidate in the
 * requested investigation (planIdForWeek staleness, .single()/
 * .maybeSingle() on multiple rows, a missing ORDER BY revision DESC,
 * selecting by week_start without picking the latest revision, a second
 * WeeklyPlan row per week, a separate read/write repository) ruled all of
 * them out against this codebase: there is exactly one weekly_plans row
 * per week (id is a real Postgres primary key -- see
 * supabase/migrations/0009_weekly_plan_lifecycle.sql), Regenerate always
 * UPDATEs that one row in place (never INSERTs a second one), and every
 * route funnels through this exact same service module -- there is no
 * second, divergent read implementation to disagree with the write.
 *
 * What CANNOT be ruled out by reading this repository's TypeScript alone
 * is an UPDATE (or DELETE) that Postgres allows to silently match ZERO
 * rows without raising any client-visible error -- the textbook cause
 * being a Row Level Security USING policy quietly filtering the target
 * row, but a duplicate/orphaned row under the same id, or a genuinely
 * different backing store for the write vs. the read, would look
 * identical from here too. This is exactly why weekly-plan-service.ts now
 * performs a mandatory, same-request read-back (verifyPlanPersisted)
 * after every plan-persisting write and refuses to report success unless
 * a fresh read actually confirms the new revision, roster count, and
 * assignment count -- turning "trust the client library's reported
 * success" into "prove it, in this same request, or fail loudly."
 *
 * This suite simulates that exact silent-failure mode with a fake
 * Supabase whose `.update()` can be told to no-op (as a real RLS-filtered
 * UPDATE would) and confirms verifyPlanPersisted now catches it instead
 * of letting a phantom revision bump reach the caller.
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
      rows = rows.slice(0, 1000);
    }
    return Promise.resolve({ data: rows, error: null }).then(onfulfilled as any);
  }
}

/**
 * Same shape as the other test files' fake tables, EXCEPT `.update()` can
 * be told, per-table, to silently affect zero rows -- reproducing exactly
 * what a Row Level Security USING policy does to an UPDATE/DELETE whose
 * target row it filters out: no error, no rows changed, nothing to catch
 * downstream except an explicit read-back.
 */
class FakeTable {
  rows: FakeRow[] = [];
  sabotageUpdates = false;
  sabotageDeletes = false;

  insert(records: FakeRow | FakeRow[]) {
    const arr = Array.isArray(records) ? records : [records];
    this.rows.push(...arr);
    return Promise.resolve({ data: arr, error: null });
  }

  upsert(records: FakeRow | FakeRow[], _opts?: { onConflict?: string }) {
    const arr = Array.isArray(records) ? records : [records];
    for (const record of arr) {
      const idx = this.rows.findIndex((r) => r.id === record.id);
      if (idx >= 0) this.rows[idx] = record;
      else this.rows.push(record);
    }
    return Promise.resolve({ data: arr, error: null });
  }

  select(_cols: string): FakeQuery {
    return new FakeQuery(this);
  }

  update(patch: FakeRow) {
    return {
      eq: (col: string, val: unknown) => {
        if (!this.sabotageUpdates) {
          this.rows = this.rows.map((r) => (r[col] === val ? { ...r, ...patch } : r));
        }
        // A real RLS-filtered UPDATE matches zero rows and still reports
        // no error -- reproduce that silence exactly.
        return Promise.resolve({ error: null });
      },
    };
  }

  delete() {
    return {
      neq: (_col: string, _val: unknown) => {
        if (!this.sabotageDeletes) this.rows = [];
        return Promise.resolve({ error: null });
      },
      eq: (col: string, val: unknown) => {
        // A real RLS-filtered DELETE matches zero rows and still reports
        // no error -- reproduce that silence exactly.
        if (!this.sabotageDeletes) this.rows = this.rows.filter((r) => r[col] !== val);
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

  sabotageUpdatesOn(name: string) {
    this.from(name); // ensure it exists
    (this.tables.get(name) as FakeTable).sabotageUpdates = true;
  }

  sabotageDeletesOn(name: string) {
    this.from(name); // ensure it exists
    (this.tables.get(name) as FakeTable).sabotageDeletes = true;
  }

  seedFacts() {
    this.from("employees").insert(EMPLOYEES as unknown as FakeRow[]);
    this.from("flights").insert(FLIGHTS as unknown as FakeRow[]);
  }
}

const WEEK_START = "2026-09-01";
const WEEK_LABEL = "Test Week";

describe("weekly-plan-service — read-your-own-write persistence verification", () => {
  it("a healthy regenerate (no simulated write failure) is unaffected: passes verification exactly as before", async () => {
    const fake = new FakeSupabase();
    fake.seedFacts();
    const first = await generateDraftPlan(fake as unknown as SupabaseClient, WEEK_START, WEEK_LABEL, DAYS_WITH_DATA, CONFIG);
    if ("blocked" in first) throw new Error("setup failed");

    const second = await regenerateDraftPlan(fake as unknown as SupabaseClient, first.plan.id, DAYS_WITH_DATA, CONFIG);
    expect("blocked" in second).toBe(false);
    if ("blocked" in second) throw new Error("unreachable");
    expect(second.plan.revision).toBe(2);
  });

  it("catches a silently no-op'd UPDATE (the traced RLS-style failure mode) instead of reporting a phantom revision bump", async () => {
    const fake = new FakeSupabase();
    fake.seedFacts();
    const first = await generateDraftPlan(fake as unknown as SupabaseClient, WEEK_START, WEEK_LABEL, DAYS_WITH_DATA, CONFIG);
    if ("blocked" in first) throw new Error("setup failed");
    expect(first.plan.revision).toBe(1);

    // Simulate exactly what a Row Level Security USING policy does to the
    // weekly_plans UPDATE: the call itself reports no error, but the
    // target row never actually changes.
    fake.sabotageUpdatesOn("weekly_plans");

    // Without verifyPlanPersisted, this call would have returned
    // `{ plan: { ...existing, revision: 2, ... } }` -- a plausible-looking
    // success built entirely from in-memory JS objects -- while the
    // actual persisted row silently stayed at revision 1. With it, the
    // function must now refuse to report that success.
    await expect(regenerateDraftPlan(fake as unknown as SupabaseClient, first.plan.id, DAYS_WITH_DATA, CONFIG)).rejects.toThrow(
      /persistence verification failed[\s\S]*expected revision 2[\s\S]*revision 1/
    );

    // And critically: the plan row genuinely never advanced -- this proves
    // the verification is reporting reality, not a false alarm.
    const plans = fake.table("weekly_plans") as unknown as WeeklyPlan[];
    expect(plans[0].revision).toBe(1);
  });

  it("catches a silently no-op'd roster DELETE that would otherwise leave two revisions' roster rows mixed in the same table", async () => {
    const fake = new FakeSupabase();
    fake.seedFacts();
    const first = await generateDraftPlan(fake as unknown as SupabaseClient, WEEK_START, WEEK_LABEL, DAYS_WITH_DATA, CONFIG);
    if ("blocked" in first) throw new Error("setup failed");

    // Simulate an RLS policy (or any other silent failure) that lets the
    // old revision's roster rows survive the "wipe before re-insert" step
    // -- the DELETE call itself reports no error, exactly like a real
    // RLS-filtered DELETE, but nothing is actually removed. The insert of
    // revision 2's rows then lands ALONGSIDE the untouched revision-1
    // rows instead of replacing them.
    fake.sabotageDeletesOn("weekly_plan_roster_entries");

    await expect(regenerateDraftPlan(fake as unknown as SupabaseClient, first.plan.id, DAYS_WITH_DATA, CONFIG)).rejects.toThrow(
      /roster entries[\s\S]*MORE rows than expected/
    );
  });
});
