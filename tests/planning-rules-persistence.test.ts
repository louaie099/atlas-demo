import { describe, it, expect } from "vitest";
import { loadLaborRules, saveLaborRuleEdit, resolveEffectiveConfig, loadFatigueConfig, saveFatigueConfig } from "../lib/planning/rules-service";
import { DEFAULT_LABOR_RULES, resolveDefaultLaborRules } from "../lib/labor-rules";
import { DEFAULT_FATIGUE_CONFIG } from "../lib/fatigue-config";

/**
 * A minimal fake Supabase supporting exactly what lib/planning/rules-service.ts
 * needs: .select("*").eq(...) (filtered rows, thenable), .update(patch).eq(...),
 * .insert(row), .upsert(row, opts) — same shape/spirit as the fakes in
 * tests/weekly-plan-lifecycle.test.ts, kept local and minimal here since this
 * file only ever touches two tables.
 */
interface FakeRow {
  [key: string]: unknown;
}

class FakeTable {
  rows: FakeRow[] = [];
  insert(record: FakeRow) {
    this.rows.push(record);
    return Promise.resolve({ error: null });
  }
  upsert(record: FakeRow, _opts?: { onConflict?: string }) {
    const idx = this.rows.findIndex((r) => r.id === record.id);
    if (idx >= 0) this.rows[idx] = record;
    else this.rows.push(record);
    return Promise.resolve({ error: null });
  }
  update(patch: FakeRow) {
    return {
      eq: (col: string, val: unknown) => {
        this.rows = this.rows.map((r) => (r[col] === val ? { ...r, ...patch } : r));
        return Promise.resolve({ error: null });
      },
    };
  }
  select(_cols: string) {
    const filters: [string, unknown][] = [];
    const query = {
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return query;
      },
      then: (onfulfilled: (v: { data: FakeRow[]; error: null }) => unknown) =>
        Promise.resolve({ data: this.rows.filter((r) => filters.every(([c, v]) => r[c] === v)), error: null }).then(onfulfilled),
    };
    return query;
  }
}

class FakeSupabase {
  private tables = new Map<string, FakeTable>();
  from(name: string): any {
    if (!this.tables.get(name)) this.tables.set(name, new FakeTable());
    return this.tables.get(name)!;
  }
}

describe("Planning Rules persistence (lib/planning/rules-service.ts)", () => {
  it("empty table falls back to the static DEFAULT_LABOR_RULES — never an error, never a guessed value", async () => {
    const supabase = new FakeSupabase() as any;
    const rules = await loadLaborRules(supabase);
    expect(rules).toBe(DEFAULT_LABOR_RULES);
  });

  it("saving an edit persists a NEW effective-dated row (never an in-place mutation) and resolveEffectiveConfig reflects it", async () => {
    const supabase = new FakeSupabase() as any;
    const before = await resolveEffectiveConfig(supabase);
    expect(before.minimum_rest_hours).toBe(15);

    await saveLaborRuleEdit(supabase, { minimumRestHours: 20 }, "2026-06-01");
    const after = await resolveEffectiveConfig(supabase, "2026-06-01");
    expect(after.minimum_rest_hours).toBe(20);

    // The table now has TWO rows (old default row, if any real DB row backed
    // it, plus the new one) — since the fake started empty, exactly one new
    // row is inserted (there was no existing DB row to close).
    const rows = await loadLaborRules(supabase);
    expect(rows.length).toBe(1);
    expect(rows[0].minimumRestHours).toEqual({ value: 20, source: "confirmed_management_policy" });
  });

  it("a SECOND edit closes out the first row and adds a new one — real version history, not an overwrite", async () => {
    const supabase = new FakeSupabase() as any;
    await saveLaborRuleEdit(supabase, { minimumRestHours: 20 }, "2026-06-01");
    await saveLaborRuleEdit(supabase, { minimumRestHours: 18 }, "2026-07-01");

    const rows = await loadLaborRules(supabase);
    expect(rows).toHaveLength(2);
    const first = rows.find((r) => r.effectiveFrom === "2026-06-01")!;
    const second = rows.find((r) => r.effectiveFrom === "2026-07-01")!;
    expect(first.effectiveTo).toBe("2026-07-01"); // closed exactly when the second begins
    expect(second.effectiveTo).toBeNull();
    expect(first.minimumRestHours.value).toBe(20);
    expect(second.minimumRestHours.value).toBe(18);

    // Resolving BEFORE the second edit's effective date still sees the first value.
    expect((await resolveEffectiveConfig(supabase, "2026-06-15")).minimum_rest_hours).toBe(20);
    expect((await resolveEffectiveConfig(supabase, "2026-07-15")).minimum_rest_hours).toBe(18);
  });

  it("PART 2 of point 6: an edit MAY be effective-dated in the FUTURE without retroactively changing what resolves for dates between now and then", async () => {
    const supabase = new FakeSupabase() as any;
    await saveLaborRuleEdit(supabase, { minimumRestHours: 20 }, "2026-06-01"); // today, in this scenario
    // Schedule a future change, taking effect 2026-12-01, without waiting for that date.
    await saveLaborRuleEdit(supabase, { minimumRestHours: 17 }, "2026-12-01", "2026-06-01");

    expect((await resolveEffectiveConfig(supabase, "2026-06-01")).minimum_rest_hours).toBe(20); // unaffected right now
    expect((await resolveEffectiveConfig(supabase, "2026-11-30")).minimum_rest_hours).toBe(20); // unaffected right up to the boundary
    expect((await resolveEffectiveConfig(supabase, "2026-12-01")).minimum_rest_hours).toBe(17); // takes effect exactly then
  });

  it("edits merge over the current values — an edit to one field never resets the others to their defaults", async () => {
    const supabase = new FakeSupabase() as any;
    await saveLaborRuleEdit(supabase, { normalWeeklyOffDays: 3 }, "2026-06-01");
    const resolved = resolveDefaultLaborRules("2026-06-01", await loadLaborRules(supabase));
    expect(resolved.normalWeeklyOffDays).toBe(3);
    expect(resolved.minimumRestHours).toBe(15); // untouched, still the default
    expect(resolved.maxConsecutiveWorkDays).toBe(5); // untouched
  });

  it("an explicit edit of maxConsecutiveWorkDays becomes confirmed_management_policy — the DEFAULT (never-edited) value stays honestly unconfirmed_prototype", async () => {
    const supabase = new FakeSupabase() as any;
    expect(resolveDefaultLaborRules().maxConsecutiveWorkDaysSource).toBe("unconfirmed_prototype");
    await saveLaborRuleEdit(supabase, { maxConsecutiveWorkDays: 6 }, "2026-06-01");
    const resolved = resolveDefaultLaborRules("2026-06-01", await loadLaborRules(supabase));
    expect(resolved.maxConsecutiveWorkDays).toBe(6);
    expect(resolved.maxConsecutiveWorkDaysSource).toBe("confirmed_management_policy");
  });

  it("hardWeeklyHoursCap does not exist anywhere (2026-09-29 follow-up audit) — not editable, not resolved, not part of Config at all: the hidden 42h Monday-Sunday cap was removed, not relabeled", async () => {
    const supabase = new FakeSupabase() as any;
    await saveLaborRuleEdit(supabase, { minimumRestHours: 16 } as any, "2026-06-01");
    const resolved = resolveDefaultLaborRules("2026-06-01", await loadLaborRules(supabase));
    expect(resolved).not.toHaveProperty("hardWeeklyHoursCap");
    expect(await resolveEffectiveConfig(supabase, "2026-06-01")).not.toHaveProperty("hard_weekly_hours_cap");
  });

  it("fatigue config: empty table falls back to DEFAULT_FATIGUE_CONFIG (disabled); saving persists and resolveEffectiveConfig reflects it", async () => {
    const supabase = new FakeSupabase() as any;
    expect(await loadFatigueConfig(supabase)).toEqual(DEFAULT_FATIGUE_CONFIG);
    expect((await resolveEffectiveConfig(supabase)).fatigue?.enabled).toBe(false);

    const enabled = { ...DEFAULT_FATIGUE_CONFIG, enabled: true };
    await saveFatigueConfig(supabase, enabled);
    expect(await loadFatigueConfig(supabase)).toEqual(enabled);
    expect((await resolveEffectiveConfig(supabase)).fatigue?.enabled).toBe(true);
  });
});
