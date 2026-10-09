import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllAssignmentsForPlan, fetchAllRequirementsForFlightIds, fetchAllTableRows } from "../lib/planning/weekly-plan-service";
import { Assignment, StaffingRequirement } from "../lib/types";

/**
 * Regression coverage for the 2026-10-09 production incident: Live
 * Operations' "Assign agent" button appeared to do nothing on a real
 * click, and a SECOND click on the same still-displayed gap crashed with
 * a raw Postgres `duplicate key value violates unique constraint
 * "assignments_pkey"` instead of a clean, actionable error.
 *
 * Root cause, confirmed live: `app/api/assign/route.ts`'s own
 * "already assigned" duplicate-safety check, `lib/planning/
 * candidate-lookup.ts`'s Find Agent candidate list, and
 * `loadPersistedPlanView`'s own Live Operations/Flight Coverage read
 * (lib/planning/weekly-plan-service.ts) all fetched `assignments` and/or
 * `staffing_requirements` with a bare, unpaginated `.select("*")`.
 * PostgREST silently caps an unbounded select at 1000 rows (no error) --
 * and a single ordinary week of this demo's real CMN/RAM flight data
 * (~70 flights/day * ~2.3 requirements/flight * 7 days) already produces
 * more than 1000 staffing_requirements rows, with a comparable count of
 * assignments once most of the week is staffed. So the FIRST "Assign"
 * click actually succeeded and was persisted -- but the very next
 * Live Operations read silently truncated before reaching that row, so
 * it kept showing as an uncovered gap ("nothing happened"); a second
 * click on the same still-displayed gap then also silently missed the
 * row in the duplicate-safety check and crashed trying to re-insert it.
 *
 * This file is a minimal, fake-Supabase-only reproduction of exactly that
 * truncation, isolated from the rest of the planning pipeline: it proves
 * the three paginated helpers these call sites were fixed to use
 * (fetchAllAssignmentsForPlan, fetchAllRequirementsForFlightIds,
 * fetchAllTableRows) genuinely read every row past the cap, rather than
 * re-testing the whole Assign/Find Agent/Live Operations flow end to end.
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

  // Mirrors supabase-js's .range(from, to) -- the mechanism
  // fetchAllAssignmentsForPlan/fetchAllRequirementsForFlightIds/
  // fetchAllTableRows actually page through.
  range(from: number, to: number): FakeQuery {
    const next = new FakeQuery(this.table, this.filters, this.inFilters);
    next.rangeBounds = [from, to];
    return next;
  }

  then<TResult1 = { data: FakeRow[]; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: FakeRow[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null
  ): PromiseLike<TResult1 | TResult2> {
    let rows = this.table.rows
      .filter((r) => this.filters.every(([c, v]) => r[c] === v))
      .filter((r) => this.inFilters.every(([c, vals]) => vals.includes(r[c])));
    if (this.rangeBounds) {
      const [from, to] = this.rangeBounds;
      rows = rows.slice(from, to + 1);
    } else {
      // The real PostgREST db-max-rows default this whole incident was
      // caused by -- reproduced here so a regression back to a plain,
      // unpaginated `.select("*")` fails this test instead of only
      // failing in production.
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
}

class FakeSupabase {
  private tables = new Map<string, FakeTable>();
  from(name: string): any {
    if (!this.tables.get(name)) this.tables.set(name, new FakeTable());
    return this.tables.get(name)!;
  }
}

describe("assignments/staffing_requirements pagination (2026-10-09 production incident)", () => {
  it("fetchAllAssignmentsForPlan returns every assignment for a plan whose count exceeds the 1000-row PostgREST cap, including the one the duplicate-safety check actually needs", async () => {
    const fake = new FakeSupabase();
    const planId = "plan-2026-10-05";
    // 1100 rows for THIS plan, insertion order arbitrary with respect to
    // id -- the real-world equivalent of "a busy week's worth of
    // assignments." The one that matters for the duplicate-safety check
    // (req-at587-gate / the employee actually clicked) is placed near the
    // END, past row 1000, exactly where the old unpaginated fetch would
    // have silently dropped it.
    const rows: FakeRow[] = [];
    for (let i = 0; i < 1099; i++) {
      rows.push({ id: `assign-filler-${i}`, plan_id: planId, staffing_requirement_id: `req-filler-${i}`, employee_id: `emp-filler-${i}` });
    }
    rows.push({ id: "assign-req-at587-gate-sanaa-benali", plan_id: planId, staffing_requirement_id: "req-at587-gate", employee_id: "sanaa-benali" });
    fake.from("assignments").insert(rows);

    const result = await fetchAllAssignmentsForPlan(fake as unknown as SupabaseClient, planId);
    expect(result.length).toBe(1100);
    const theOneThatMatters = result.find((a) => a.staffing_requirement_id === "req-at587-gate" && a.employee_id === "sanaa-benali");
    expect(theOneThatMatters).toBeDefined();
  });

  it("fetchAllAssignmentsForPlan never returns another plan's rows, pagination or not", async () => {
    const fake = new FakeSupabase();
    fake.from("assignments").insert([
      { id: "a1", plan_id: "plan-A", staffing_requirement_id: "req-1", employee_id: "emp-1" },
      { id: "a2", plan_id: "plan-B", staffing_requirement_id: "req-2", employee_id: "emp-2" },
    ]);
    const result = await fetchAllAssignmentsForPlan(fake as unknown as SupabaseClient, "plan-A");
    expect(result.map((a) => a.id)).toEqual(["a1"]);
  });

  it("fetchAllRequirementsForFlightIds returns every requirement for a week whose count exceeds the 1000-row cap", async () => {
    const fake = new FakeSupabase();
    // ~70 flights/day * 7 days, ~2.3 requirements/flight on average --
    // the real, representative week-scale this incident was actually
    // observed at.
    const flightIds = Array.from({ length: 490 }, (_, i) => `flight-${i}`);
    const rows: FakeRow[] = [];
    let n = 0;
    for (const flightId of flightIds) {
      for (const role of ["Gate", "Boarding", "Profiling"]) {
        rows.push({ id: `req-${flightId}-${role}`, flight_id: flightId, role });
        n++;
      }
    }
    expect(n).toBeGreaterThan(1000); // sanity-check the fixture itself crosses the cap
    fake.from("staffing_requirements").insert(rows);

    const result = await fetchAllRequirementsForFlightIds(fake as unknown as SupabaseClient, flightIds);
    expect(result.length).toBe(n);
    // The requirement for the LAST flight (guaranteed past row 1000 given
    // insertion order) must actually come back -- this is exactly the
    // "flight late in the week silently has no requirements" failure mode
    // an unpaginated .in() fetch produces.
    const lastFlightReq = result.find((r) => r.flight_id === "flight-489" && r.role === "Profiling");
    expect(lastFlightReq).toBeDefined();
  });

  it("fetchAllRequirementsForFlightIds returns [] without querying when given no flight ids (no plan generated yet this week)", async () => {
    const fake = new FakeSupabase();
    const result = await fetchAllRequirementsForFlightIds(fake as unknown as SupabaseClient, []);
    expect(result).toEqual([]);
  });

  it("fetchAllTableRows (the un-scoped fallback used by the Employees routes) also pages past the 1000-row cap", async () => {
    const fake = new FakeSupabase();
    const rows: FakeRow[] = Array.from({ length: 1234 }, (_, i) => ({ id: `assign-${i}`, employee_id: `emp-${i % 50}` }));
    fake.from("assignments").insert(rows);
    const result = await fetchAllTableRows<Assignment>(fake as unknown as SupabaseClient, "assignments");
    expect(result.length).toBe(1234);
  });
});
