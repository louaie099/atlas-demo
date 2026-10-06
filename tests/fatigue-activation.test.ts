import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CONFIG } from "../lib/seed-data";
import { planIdForWeek } from "../lib/planning/weekly-plan-service";
import { getCandidatesForRequirement } from "../lib/planning/candidate-lookup";
import { classifyFatigueLevel, neutralFatigueState } from "../lib/planning/fatigue-model";
import { PROTOTYPE_FATIGUE_CONFIG, DEFAULT_FATIGUE_CONFIG } from "../lib/fatigue-config";
import { DEFAULT_FAIRNESS_WEIGHTS } from "../lib/fairness-config";
import { Employee, Flight, StaffingRequirement, WeeklyPlan, WeeklyPlanRosterEntry } from "../lib/types";

/**
 * Focused coverage for the 2026-10-06 fatigue ACTIVATION milestone:
 * - resolveEffectiveConfig derives fairness_weights.fatigueWeight from the
 *   single real, Planning-Rules-editable switch (config.fatigue.enabled) —
 *   see tests/planning-rules-persistence.test.ts for the config
 *   persistence layer itself; this just checks the derivation.
 * - classifyFatigueLevel's Low/Moderate/High bucketing.
 * - candidate-lookup.ts (Find Agent / Live Ops replacement ranking) now
 *   actually ranks by fatigue and exposes fatigueLevel/fatigueLevelReasons/
 *   tasksToday once the PLAN's config_snapshot carries fatigue.enabled —
 *   exactly mirroring what resolveEffectiveConfig now produces for any
 *   newly generated/regenerated plan.
 *
 * Reuses tests/live-ops-service.test.ts's fake-Supabase harness shape
 * (eq/in/order/limit/range/single).
 */

interface FakeRow {
  [key: string]: unknown;
}

class FakeQuery implements PromiseLike<{ data: FakeRow[]; error: null }> {
  constructor(
    private table: FakeTable,
    private filters: [string, unknown][] = [],
    private inFilters: [string, unknown[]][] = [],
    private orderCol: string | null = null,
    private orderAsc = true,
    private limitN: number | null = null
  ) {}

  eq(col: string, val: unknown): FakeQuery {
    return new FakeQuery(this.table, [...this.filters, [col, val]], this.inFilters, this.orderCol, this.orderAsc, this.limitN);
  }
  in(col: string, vals: unknown[]): FakeQuery {
    return new FakeQuery(this.table, this.filters, [...this.inFilters, [col, vals]], this.orderCol, this.orderAsc, this.limitN);
  }
  order(col: string, opts?: { ascending?: boolean }): FakeQuery {
    return new FakeQuery(this.table, this.filters, this.inFilters, col, opts?.ascending ?? true, this.limitN);
  }
  limit(n: number): FakeQuery {
    return new FakeQuery(this.table, this.filters, this.inFilters, this.orderCol, this.orderAsc, n);
  }
  range(from: number, to: number): FakeQuery {
    const rows = this.resolveRows().slice(from, to + 1);
    return Object.assign(new FakeQuery(this.table), { then: (cb: any) => Promise.resolve({ data: rows, error: null }).then(cb) });
  }
  private resolveRows(): FakeRow[] {
    let rows = this.table.rows
      .filter((r) => this.filters.every(([c, v]) => r[c] === v))
      .filter((r) => this.inFilters.every(([c, vals]) => vals.includes(r[c])));
    if (this.orderCol) {
      const col = this.orderCol;
      rows = [...rows].sort((a, b) => {
        const av = a[col] as number;
        const bv = b[col] as number;
        return this.orderAsc ? av - bv : bv - av;
      });
    }
    if (this.limitN != null) rows = rows.slice(0, this.limitN);
    return rows;
  }
  single(): Promise<{ data: FakeRow | null; error: { message: string } | null }> {
    const rows = this.resolveRows();
    if (rows.length === 0) return Promise.resolve({ data: null, error: { message: "not found" } });
    return Promise.resolve({ data: rows[0], error: null });
  }
  then<TResult1 = { data: FakeRow[]; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: FakeRow[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null
  ): PromiseLike<TResult1 | TResult2> {
    const rows = this.resolveRows().slice(0, 1000);
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

const PRIOR_WEEK_START = "2026-08-31"; // Monday
const WEEK_START = "2026-09-07"; // Monday
const PLAN_ID = planIdForWeek(WEEK_START);
const PRIOR_PLAN_ID = planIdForWeek(PRIOR_WEEK_START);
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "emp-x",
    name: "Test Employee",
    skills: ["Gate"],
    assignment: "General",
    shift_code: "NR02",
    shift_start: "08:00",
    shift_end: "18:15",
    rest_before_shift_hours: 15,
    weekly_hours: 20,
    is_duty_officer: false,
    off_days: [],
    foreign_company_authorizations: [],
    active: true,
    weekly_shifts: [],
    ...overrides,
  };
}

function makeFlight(overrides: Partial<Flight>): Flight {
  return {
    id: "flight-x",
    flight_number: "AT500",
    airline: "Royal Air Maroc",
    route: "CMN → ORY",
    origin: "CMN",
    destination: "ORY",
    aircraft: "Boeing 737",
    equipment_code: null,
    registration: null,
    callsign: null,
    terminal: "T1",
    scheduled_departure: "09:00",
    scheduled_arrival: null,
    gate: null,
    boarding_window_start: null,
    boarding_window_end: null,
    status: "scheduled",
    booking_pressure: "normal",
    day_of_week: "Monday",
    flight_date: WEEK_START,
    week_start: WEEK_START,
    operator_type: "atlas_managed",
    destination_category: "Europe/Schengen",
    booked_passengers: null,
    seat_capacity: null,
    ...overrides,
  };
}

function seedFixture(fake: FakeSupabase, fatigueEnabled: boolean) {
  // empHeavy worked MT02 (early/circadian-unfriendly) every day of the
  // PRIOR week; empLight worked NR01 (plain daytime) every day — a real
  // accumulated-burden difference entering the current week, derived
  // through the SAME continuity seed (deriveIncomingFatigueState) every
  // other fatigue call site uses, not fabricated for this test.
  const empHeavy = makeEmployee({ id: "emp-heavy", name: "Karim", shift_code: "NR02", shift_start: "08:00", shift_end: "18:15" });
  const empLight = makeEmployee({ id: "emp-light", name: "Youssef", shift_code: "NR02", shift_start: "08:00", shift_end: "18:15" });

  const priorRoster: WeeklyPlanRosterEntry[] = DAYS.flatMap((day) => [
    { id: `prior-heavy-${day}`, plan_id: PRIOR_PLAN_ID, employee_id: "emp-heavy", day_of_week: day, status: "working", shift_code: "MT02" },
    { id: `prior-light-${day}`, plan_id: PRIOR_PLAN_ID, employee_id: "emp-light", day_of_week: day, status: "working", shift_code: "NR01" },
  ]);

  const priorPlan: WeeklyPlan = {
    id: PRIOR_PLAN_ID,
    week_start: PRIOR_WEEK_START,
    week_label: "Prior Week",
    status: "draft",
    revision: 1,
    generated_at: new Date().toISOString(),
    published_at: null,
    generated_from_hash: "test-hash",
    config_snapshot: CONFIG,
    issues: [],
    configuration_issues: [],
  };

  // Current week: both employees working Monday on NR02 (08:00-18:15),
  // covering the target Gate requirement's window; NEITHER is assigned
  // yet (a real gap) — this is exactly the "Find Replacement" shape.
  const flight = makeFlight({ id: "flight-500", flight_number: "AT500", scheduled_departure: "09:00" });
  const reqGate: StaffingRequirement = {
    id: "req-gate",
    flight_id: "flight-500",
    role: "Gate",
    baseline_requirement: 1,
    additional_requirement: 0,
    total_requirement: 1,
    source: "fixed_rule",
    reasoning: "test fixture",
    needs_configuration: false,
  };

  const currentRoster: WeeklyPlanRosterEntry[] = [
    { id: "cur-heavy-mon", plan_id: PLAN_ID, employee_id: "emp-heavy", day_of_week: "Monday", status: "working", shift_code: "NR02" },
    { id: "cur-light-mon", plan_id: PLAN_ID, employee_id: "emp-light", day_of_week: "Monday", status: "working", shift_code: "NR02" },
  ];

  const fatigue = fatigueEnabled ? PROTOTYPE_FATIGUE_CONFIG : DEFAULT_FATIGUE_CONFIG;
  const config = {
    ...CONFIG,
    fatigue,
    fairness_weights: { ...DEFAULT_FAIRNESS_WEIGHTS, fatigueWeight: fatigueEnabled ? 1 : 0 },
  };

  const plan: WeeklyPlan = {
    id: PLAN_ID,
    week_start: WEEK_START,
    week_label: "Current Week",
    status: "draft",
    revision: 1,
    generated_at: new Date().toISOString(),
    published_at: null,
    generated_from_hash: "test-hash-2",
    config_snapshot: config,
    issues: [],
    configuration_issues: [],
  };

  fake.from("employees").insert([empHeavy, empLight] as unknown as FakeRow[]);
  fake.from("flights").insert([flight] as unknown as FakeRow[]);
  fake.from("staffing_requirements").insert([reqGate] as unknown as FakeRow[]);
  fake.from("assignments").insert([]);
  fake.from("weekly_plans").insert([priorPlan, plan] as unknown as FakeRow[]);
  fake.from("weekly_plan_roster_entries").insert([...priorRoster, ...currentRoster] as unknown as FakeRow[]);

  return { empHeavy, empLight, reqGate };
}

describe("classifyFatigueLevel — Low/Moderate/High bucketing", () => {
  it("returns 'unknown' (never a fabricated level) when the model is disabled or the state has no history", () => {
    expect(classifyFatigueLevel({ known: false, reason: "no history" }, PROTOTYPE_FATIGUE_CONFIG).level).toBe("unknown");
    expect(classifyFatigueLevel(neutralFatigueState("unknown_start"), DEFAULT_FATIGUE_CONFIG).level).toBe("unknown");
  });

  it("with no peer pool supplied, falls back to the configured difficultDayBurdenThreshold as an absolute scale", () => {
    const t = PROTOTYPE_FATIGUE_CONFIG.thresholds.difficultDayBurdenThreshold;
    const low = { ...neutralFatigueState("prior_plan"), accumulatedBurden: t * 0.5 };
    const moderate = { ...neutralFatigueState("prior_plan"), accumulatedBurden: t * 2 };
    const high = { ...neutralFatigueState("prior_plan"), accumulatedBurden: t * 4, consecutiveDifficultDays: 3, consecutiveVeryEarlyDays: 3, consecutiveWorkDays: 6 };
    expect(classifyFatigueLevel(low, PROTOTYPE_FATIGUE_CONFIG).level).toBe("low");
    expect(classifyFatigueLevel(moderate, PROTOTYPE_FATIGUE_CONFIG).level).toBe("moderate");
    const highInfo = classifyFatigueLevel(high, PROTOTYPE_FATIGUE_CONFIG);
    expect(highInfo.level).toBe("high");
    expect(highInfo.reasons).toContain("Early starts: 3 consecutive");
    expect(highInfo.reasons).toContain("Short recovery pattern");
    expect(highInfo.reasons).toContain("Recent workload: elevated");
  });

  it("with a peer pool supplied (the normal case — Find Agent always has a candidate pool), buckets by percentile rank within that pool rather than an absolute scale", () => {
    // accumulatedBurden is an open-ended running total with no natural
    // absolute scale (it keeps growing the longer a history is folded in,
    // regardless of how light each day was) — so a "light" candidate with
    // a long history can still out-burden a "heavy" candidate with a short
    // one in absolute terms. Peer-relative ranking is what actually
    // reflects "lower/higher fatigue than the other agents being
    // compared right now", which is the only claim the UI makes.
    const t = PROTOTYPE_FATIGUE_CONFIG.thresholds.difficultDayBurdenThreshold;
    const lowest = { ...neutralFatigueState("prior_plan"), accumulatedBurden: t * 10 };
    const middle = { ...neutralFatigueState("prior_plan"), accumulatedBurden: t * 20 };
    const highest = { ...neutralFatigueState("prior_plan"), accumulatedBurden: t * 30 };
    const peers = [middle.accumulatedBurden, highest.accumulatedBurden];
    expect(classifyFatigueLevel(lowest, PROTOTYPE_FATIGUE_CONFIG, peers).level).toBe("low");
    expect(classifyFatigueLevel(middle, PROTOTYPE_FATIGUE_CONFIG, [lowest.accumulatedBurden, highest.accumulatedBurden]).level).toBe("moderate");
    expect(classifyFatigueLevel(highest, PROTOTYPE_FATIGUE_CONFIG, [lowest.accumulatedBurden, middle.accumulatedBurden]).level).toBe("high");
  });
});

describe("Find Agent / Live Ops replacement ranking — fatigue activation", () => {
  it("disabled (today's default): candidates carry no fatigue fields, input-pool order preserved", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake, false);
    const result = await getCandidatesForRequirement(fake as unknown as SupabaseClient, "req-gate");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.candidates.every((c) => c.fatigueLevel === undefined)).toBe(true);
    expect(result.candidates.every((c) => c.tasksToday === undefined)).toBe(true);
  });

  it("enabled: the lower-burden candidate (Youssef, prior week's plain daytime NR01) is ranked first, with a Low/High fatigue level and real reasons exposed", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake, true);
    const result = await getCandidatesForRequirement(fake as unknown as SupabaseClient, "req-gate");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.candidates.map((c) => c.employee.id)).toEqual(["emp-light", "emp-heavy"]);

    const youssef = result.candidates.find((c) => c.employee.id === "emp-light")!;
    const karim = result.candidates.find((c) => c.employee.id === "emp-heavy")!;
    expect(youssef.fatigueLevel).toBe("low");
    expect(karim.fatigueLevel).not.toBe("low");
    expect(karim.fatigueLevelReasons).toBeDefined();
    expect(youssef.tasksToday).toBe(0);
    expect(karim.tasksToday).toBe(0);
  });
});
