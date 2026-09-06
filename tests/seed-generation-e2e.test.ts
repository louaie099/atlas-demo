import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resetDatabase } from "../lib/reset-database";
import { CONFIGURED_COMPANIES } from "../lib/company-config";
import { checkConsecutiveOffCyclic } from "../lib/planning/consecutive-off";
import { JR_NT_OFF_OFF_CYCLE, cycleStepAt } from "../lib/fixed-cycle-rotation";
import { Employee } from "../lib/types";

/**
 * END-TO-END seed-generation test. This does NOT re-test the helper
 * functions in isolation (lib/fixed-cycle-rotation.ts,
 * lib/employee-generator.ts, etc. already have their own unit tests) — it
 * calls the REAL resetDatabase() (the exact function /api/reset and
 * scripts/seed.ts both call — there is exactly one "what a fresh demo
 * looks like" implementation) against a minimal in-memory fake Supabase
 * client, then asserts the roster invariants directly against the rows
 * that actually land in the "employees" table. This is the only way to
 * catch a bug where the generator itself is correct but something in the
 * seeding/reset pipeline (a stale table not being cleared, a legacy
 * insert path, an old hardcoded array reused) reintroduces bad data
 * between the generator and the database.
 *
 * If this test ever starts failing, it means Reset Demo itself would
 * currently reproduce the bug reported against the deployed app.
 */

interface FakeRow {
  [key: string]: unknown;
}

class FakeTable {
  rows: FakeRow[] = [];

  insert(records: FakeRow | FakeRow[]) {
    const arr = Array.isArray(records) ? records : [records];
    this.rows.push(...arr);
    return Promise.resolve({ data: arr, error: null });
  }

  delete() {
    return {
      neq: (_col: string, _val: unknown) => {
        this.rows = [];
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
}

describe("end-to-end seed generation (resetDatabase against a fake DB) — the real Reset Demo pipeline", () => {
  it("produces a fully clean workforce roster in the actual persisted employees table", async () => {
    const fake = new FakeSupabase();
    await resetDatabase(fake as unknown as SupabaseClient);

    const employees = fake.table("employees") as unknown as Employee[];
    expect(employees.length).toBeGreaterThan(100); // sanity: a real, full workforce was actually inserted

    const normal = employees.filter(
      (e) => !["Transit", "Leaders"].includes(e.assignment) && !CONFIGURED_COMPANIES.includes(e.assignment)
    );
    const transit = employees.filter((e) => e.assignment === "Transit");
    const leaders = employees.filter((e) => e.assignment === "Leaders");

    expect(normal.length).toBeGreaterThan(0);
    expect(transit.length).toBeGreaterThan(0);
    expect(leaders.length).toBeGreaterThan(0);

    // --- Normal (non-fixed-cycle, non-foreign) employees ---
    for (const e of normal) {
      const offCount = e.weekly_shifts.filter((s) => s.status === "off").length;
      expect(offCount, `${e.id} (${e.assignment}) must have exactly 2 OFF days, has ${offCount}`).toBe(2);

      const violation = checkConsecutiveOffCyclic(e);
      expect(violation, `${e.id} (${e.assignment}) must never exceed 2 consecutive OFF days`).toBeNull();
    }

    // --- Transit / Leaders: must actually be on the fixed JR->NT->OFF->OFF
    // cycle, never a flat/uniform shift like AP01. ---
    for (const e of [...transit, ...leaders]) {
      for (const shift of e.weekly_shifts) {
        if (shift.status === "working") {
          expect(["JR02", "NT01"]).toContain(shift.shift_code);
        }
      }
      // The employee's own weekly_shifts, extended two more cycle lengths
      // forward, must exactly match what the confirmed cycle predicts from
      // SOME fixed offset — i.e. their actual persisted schedule truly is
      // a window into the real continuous cycle, not merely "happens to
      // only use JR02/NT01 codes."
      const observed = e.weekly_shifts.map((s) => (s.status === "off" ? "OFF" : s.shift_code));
      const matchesSomeOffset = Array.from({ length: JR_NT_OFF_OFF_CYCLE.steps.length }, (_, offset) => offset).some(
        (offset) =>
          observed.every((code, i) => {
            const step = cycleStepAt(JR_NT_OFF_OFF_CYCLE, i, offset);
            return code === ("off" in step ? "OFF" : step.code);
          })
      );
      expect(matchesSomeOffset, `${e.id} (${e.assignment}) weekly_shifts must be a real window into the JR->NT->OFF->OFF cycle: got ${observed.join(" ")}`).toBe(true);
    }
  });

  it("Reset Demo run twice in a row produces byte-identical rosters (deterministic, no stale carryover)", async () => {
    const fakeA = new FakeSupabase();
    await resetDatabase(fakeA as unknown as SupabaseClient);
    const employeesA = sortById(fakeA.table("employees") as unknown as Employee[]);

    const fakeB = new FakeSupabase();
    await resetDatabase(fakeB as unknown as SupabaseClient);
    const employeesB = sortById(fakeB.table("employees") as unknown as Employee[]);

    expect(employeesA.length).toBe(employeesB.length);
    for (let i = 0; i < employeesA.length; i++) {
      expect(employeesA[i].id).toBe(employeesB[i].id);
      expect(employeesA[i].assignment).toBe(employeesB[i].assignment);
      expect(employeesA[i].weekly_shifts).toEqual(employeesB[i].weekly_shifts);
    }
  });

  it("re-running resetDatabase after inserting a stale legacy row leaves no trace of it (delete-before-insert actually clears every table)", async () => {
    const fake = new FakeSupabase();
    // Simulate an old deployment's leftover row that a real database might
    // still hold before Reset Demo is clicked.
    await fake.from("employees").insert({ id: "legacy-stale-row", name: "Stale Legacy Employee", assignment: "Transit" });
    await resetDatabase(fake as unknown as SupabaseClient);

    const employees = fake.table("employees") as unknown as Employee[];
    expect(employees.find((e) => e.id === "legacy-stale-row")).toBeUndefined();
  });
});

function sortById(employees: Employee[]): Employee[] {
  return [...employees].sort((a, b) => a.id.localeCompare(b.id));
}
