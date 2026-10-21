import { describe, it, expect } from "vitest";
import { resetToEmptyDatabase } from "../lib/reset-empty";

/**
 * resetToEmptyDatabase (2026-10-20 "Reset" / "Load dataset" split) must
 * wipe every table this codebase's three reset-*.ts files all agree on,
 * and must NOT insert a single row afterwards -- no dataset, no plan, no
 * audit entry. A minimal fake standing in for the handful of
 * SupabaseClient methods it actually calls (.from().delete().neq()) is
 * enough; this is not re-testing FK-safe ordering (nothing here depends
 * on order, since every call is an unconditional full-table wipe), only
 * that every expected table is actually wiped and nothing is written.
 */
class FakeTable {
  rows: Record<string, unknown>[] = [{ id: "pre-existing-row" }];
  deleteNeqCalls: [string, unknown][] = [];
  insertCalls: unknown[] = [];
  delete() {
    return {
      neq: (col: string, val: unknown) => {
        this.deleteNeqCalls.push([col, val]);
        this.rows = [];
        return Promise.resolve({ error: null });
      },
      eq: (col: string, val: unknown) => {
        this.rows = this.rows.filter((r) => r[col] !== val);
        return Promise.resolve({ error: null });
      },
    };
  }
  insert(records: unknown) {
    this.insertCalls.push(records);
    return Promise.resolve({ data: records, error: null });
  }
  select() {
    return {
      eq: () => ({ single: () => Promise.resolve({ data: null, error: { message: "not found" } }) }),
    };
  }
}

class FakeSupabase {
  tables = new Map<string, FakeTable>();
  from(name: string): any {
    if (!this.tables.get(name)) this.tables.set(name, new FakeTable());
    return this.tables.get(name)!;
  }
}

const EXPECTED_WIPED_TABLES = [
  "audit_log_entries",
  "assignment_modifications",
  "assignments",
  "weekly_plan_roster_entries",
  "weekly_plans",
  "planned_duties",
  "staffing_requirements",
  "flights",
  "employees",
];

describe("lib/reset-empty — resetToEmptyDatabase", () => {
  it("wipes every table the three dataset resets agree on, and inserts nothing", async () => {
    const db = new FakeSupabase();
    // Pre-touch every table so `.from(name)` creates a FakeTable with a
    // pre-existing row to actually wipe.
    for (const name of EXPECTED_WIPED_TABLES) db.from(name);

    await resetToEmptyDatabase(db as any);

    for (const name of EXPECTED_WIPED_TABLES) {
      const table = db.tables.get(name)!;
      expect(table.deleteNeqCalls.length).toBe(1);
      expect(table.rows).toEqual([]);
      expect(table.insertCalls.length).toBe(0);
    }
  });

  it("leaves tables it was never asked to wipe untouched", async () => {
    const db = new FakeSupabase();
    const untouched = db.from("some_other_table");
    await resetToEmptyDatabase(db as any);
    expect(untouched.deleteNeqCalls.length).toBe(0);
  });
});

describe("reset keeps labor rules", () => {
  it("does not touch planning_labor_rules or planning_fatigue_config", async () => {
    const db = new FakeSupabase();
    const rules = db.from("planning_labor_rules");
    const fatigue = db.from("planning_fatigue_config");
    const spyR = JSON.stringify(rules), spyF = JSON.stringify(fatigue);
    await resetToEmptyDatabase(db as never);
    expect(JSON.stringify(db.from("planning_labor_rules"))).toBe(spyR);
    expect(JSON.stringify(db.from("planning_fatigue_config"))).toBe(spyF);
  });
});
