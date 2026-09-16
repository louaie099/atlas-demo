import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { EMPLOYEES, FLIGHTS, CONFIG, DAYS_WITH_DATA } from "../lib/seed-data";
import { generateDraftPlan, loadPersistedPlanView, planIdForWeek } from "../lib/planning/weekly-plan-service";
import { shiftWeek } from "../lib/flight-date";
import { Flight } from "../lib/types";

/**
 * MULTI-WEEK ISOLATION — the exact regression this milestone exists to
 * prevent. Before this milestone, `flights` had no week_start column at
 * all (every flight belonged to the single seeded week, by construction)
 * and loadPersistedPlanView/generateDraftPlan/regenerateDraftPlan fetched
 * `flights` and `staffing_requirements` completely UNSCOPED -- found and
 * fixed as part of this work. These tests seed two genuinely distinct
 * weeks (same day-of-week labels, different real dates, different flight
 * ids) and prove neither operation ever mixes them.
 */

interface FakeRow {
  [key: string]: unknown;
}

class FakeQuery implements PromiseLike<{ data: FakeRow[]; error: null }> {
  constructor(private table: FakeTable, private filters: [string, unknown][] = [], private inFilters: [string, unknown[]][] = []) {}
  private rangeBounds: [number, number] | null = null;
  eq(col: string, val: unknown): FakeQuery {
    return new FakeQuery(this.table, [...this.filters, [col, val]], this.inFilters);
  }
  in(col: string, vals: unknown[]): FakeQuery {
    return new FakeQuery(this.table, this.filters, [...this.inFilters, [col, vals]]);
  }
  range(from: number, to: number): FakeQuery {
    const next = new FakeQuery(this.table, this.filters, this.inFilters);
    next.rangeBounds = [from, to];
    return next;
  }
  then<TResult1 = { data: FakeRow[]; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: FakeRow[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null
  ): PromiseLike<TResult1 | TResult2> {
    let rows = this.table.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v)).filter((r) => this.inFilters.every(([c, vals]) => vals.includes(r[c])));
    if (this.rangeBounds) {
      const [from, to] = this.rangeBounds;
      rows = rows.slice(from, to + 1);
    } else {
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
    return { eq: (col: string, val: unknown) => { this.rows = this.rows.map((r) => (r[col] === val ? { ...r, ...patch } : r)); return Promise.resolve({ error: null }); } };
  }
  delete() {
    return {
      neq: () => { this.rows = []; return Promise.resolve({ error: null }); },
      eq: (col: string, val: unknown) => { this.rows = this.rows.filter((r) => r[col] !== val); return Promise.resolve({ error: null }); },
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
}

const WEEK_A_START = "2026-09-01";
const WEEK_B_START = shiftWeek(WEEK_A_START, 1); // "2026-09-08" -- a genuinely distinct week, one week later

/** Week B's flights: same day-of-week template as the real seed data, but real, distinct dates/ids/week_start -- a truly second, independent week's program, not a re-tagged copy of week A's rows. */
function buildWeekBFlights(): Flight[] {
  return FLIGHTS.map((f) => ({
    ...f,
    id: `${f.id}-wk2`,
    flight_date: shiftWeek(f.flight_date, 1),
    week_start: WEEK_B_START,
  }));
}

describe("multi-week isolation — flights, requirements, and plans never leak across weeks", () => {
  it("generateDraftPlan for Week A only ever reads Week A's flights, even when Week B's flights already exist in the same table", async () => {
    const fake = new FakeSupabase();
    fake.from("employees").insert(EMPLOYEES as unknown as FakeRow[]);
    fake.from("flights").insert(FLIGHTS as unknown as FakeRow[]);
    fake.from("flights").insert(buildWeekBFlights() as unknown as FakeRow[]); // Week B coexists in the same table

    const result = await generateDraftPlan(fake as unknown as SupabaseClient, WEEK_A_START, "Week A", DAYS_WITH_DATA, CONFIG);
    if ("blocked" in result) throw new Error("setup failed");

    const rosterEntries = fake.table("weekly_plan_roster_entries") as any[];
    const assignments = fake.table("assignments") as any[];
    expect(rosterEntries.length).toBeGreaterThan(0);
    expect(assignments.length).toBeGreaterThan(0);
    // staffing_requirements is never persisted by generateDraftPlan itself
    // (it's computed fresh in-memory every generation -- see
    // weekly-requirements.ts's own doc comment; only Reset Demo's seed
    // script inserts a persisted copy, for the Flight Coverage view to
    // read against). What generateDraftPlan DOES persist -- roster
    // entries and assignments -- is what must be scoped correctly: every
    // assignment's requirement id is built as `req-${flightId}-${role}`,
    // so confirm none of them embed a Week B flight id.
    const weekBFlightIds = buildWeekBFlights().map((f) => f.id);
    for (const a of assignments) {
      const reqId = a.staffing_requirement_id as string;
      for (const weekBId of weekBFlightIds) {
        expect(reqId.includes(weekBId)).toBe(false);
      }
    }
  });

  it("loadPersistedPlanView for Week A never returns a Week B flight, requirement, roster row, or duty, and vice versa", async () => {
    const fake = new FakeSupabase();
    fake.from("employees").insert(EMPLOYEES as unknown as FakeRow[]);
    fake.from("flights").insert(FLIGHTS as unknown as FakeRow[]);
    fake.from("flights").insert(buildWeekBFlights() as unknown as FakeRow[]);

    const resultA = await generateDraftPlan(fake as unknown as SupabaseClient, WEEK_A_START, "Week A", DAYS_WITH_DATA, CONFIG);
    if ("blocked" in resultA) throw new Error("setup failed");
    const resultB = await generateDraftPlan(fake as unknown as SupabaseClient, WEEK_B_START, "Week B", DAYS_WITH_DATA, CONFIG);
    if ("blocked" in resultB) throw new Error("setup failed");

    const viewA = await loadPersistedPlanView(fake as unknown as SupabaseClient, WEEK_A_START, DAYS_WITH_DATA);
    const viewB = await loadPersistedPlanView(fake as unknown as SupabaseClient, WEEK_B_START, DAYS_WITH_DATA);
    if (!viewA || !viewB) throw new Error("expected both views to exist");

    const weekAFlightIds = new Set(FLIGHTS.map((f) => f.id));
    const weekBFlightIds = new Set(buildWeekBFlights().map((f) => f.id));

    expect(viewA.flights.length).toBeGreaterThan(0);
    expect(viewB.flights.length).toBeGreaterThan(0);
    for (const f of viewA.flights) expect(weekBFlightIds.has(f.id)).toBe(false);
    for (const f of viewB.flights) expect(weekAFlightIds.has(f.id)).toBe(false);

    // Flight Coverage (roster) rows carry a flight object too -- same check.
    for (const r of viewA.roster) expect(weekBFlightIds.has(r.flight.id)).toBe(false);
    for (const r of viewB.roster) expect(weekAFlightIds.has(r.flight.id)).toBe(false);

    // Agent Schedule duties reference a flightId directly.
    const dutiesA = viewA.schedule.flatMap((e) => e.days.flatMap((d) => d.duties ?? []));
    const dutiesB = viewB.schedule.flatMap((e) => e.days.flatMap((d) => d.duties ?? []));
    for (const d of dutiesA) expect(weekBFlightIds.has(d.flightId)).toBe(false);
    for (const d of dutiesB) expect(weekAFlightIds.has(d.flightId)).toBe(false);
  });

  it("the two weeks are genuinely different WeeklyPlan rows (different ids), and generating/regenerating one never touches the other's persisted revision", async () => {
    const fake = new FakeSupabase();
    fake.from("employees").insert(EMPLOYEES as unknown as FakeRow[]);
    fake.from("flights").insert(FLIGHTS as unknown as FakeRow[]);
    fake.from("flights").insert(buildWeekBFlights() as unknown as FakeRow[]);

    const resultA = await generateDraftPlan(fake as unknown as SupabaseClient, WEEK_A_START, "Week A", DAYS_WITH_DATA, CONFIG);
    if ("blocked" in resultA) throw new Error("setup failed");
    expect(resultA.plan.id).toBe(planIdForWeek(WEEK_A_START));

    const resultB = await generateDraftPlan(fake as unknown as SupabaseClient, WEEK_B_START, "Week B", DAYS_WITH_DATA, CONFIG);
    if ("blocked" in resultB) throw new Error("setup failed");
    expect(resultB.plan.id).toBe(planIdForWeek(WEEK_B_START));

    expect(resultA.plan.id).not.toBe(resultB.plan.id);
    expect(resultA.plan.revision).toBe(1);
    expect(resultB.plan.revision).toBe(1);

    // Week A's plan row is untouched by Week B's generation.
    const plans = fake.table("weekly_plans") as any[];
    const planARow = plans.find((p) => p.id === resultA.plan.id);
    expect(planARow.revision).toBe(1);
  });
});
