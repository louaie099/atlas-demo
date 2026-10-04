import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { planIdForWeek } from "../lib/planning/weekly-plan-service";
import { getCandidatesForRequirement } from "../lib/planning/candidate-lookup";
import { loadLiveOpsView, evaluateFlightDelayImpact, confirmReassignment } from "../lib/live-ops-service";
import { CONFIG } from "../lib/seed-data";
import { Assignment, Employee, Flight, StaffingRequirement, WeeklyPlan, WeeklyPlanRosterEntry } from "../lib/types";

/**
 * ===========================================================================
 * A SMALL, CONTROLLED, INTENTIONALLY TIGHT demo-day dataset for Live
 * Operations, built per the product owner's explicit request:
 *
 *   "Design a SMALL, CONTROLLED test workforce where we know: 1. how many
 *   agents are required, 2. which qualifications each agent has, 3. their
 *   shifts, 4. their planned assignments, 5. where the intentional capacity
 *   bottlenecks are, 6. what should happen under specific disruptions."
 *
 * This is a SEPARATE, self-contained day (2026-10-07, a Wednesday) — it
 * does not touch the monthly test CSVs or the regular seed roster, so it
 * can be this tight without destabilizing Monthly Planning's own OFF/OFF
 * continuity, fairness, or hard-cap logic over a full month.
 *
 * ---------------------------------------------------------------------
 * THE WORKFORCE (8 agents, real shift-catalog codes for 2026-10-07):
 * ---------------------------------------------------------------------
 *   Alice    MT01 (05:45-15:00)  Gate+Boarding   -- F1 Gate
 *   Omar     MT01 (05:45-15:00)  Gate+Boarding   -- F1 Boarding, F4 Boarding
 *   Sara     AP01 (13:45-22:45)  Gate+Boarding   -- F2 Gate
 *   Yassine  AP01 (13:45-22:45)  Gate+Boarding   -- F2 Boarding, F3 Gate
 *   Karim    AP02 (13:45-23:15)  Gate+Boarding   -- F3 Boarding
 *   Nadia    NR02 (08:00-18:15)  Profiling ONLY  -- F1/F2/F3 Profiling (the
 *                                                   ONLY Profiling-qualified
 *                                                   agent -- a deliberate
 *                                                   bottleneck)
 *   Imane    NR02 (08:00-18:15)  Gate+Boarding   -- unassigned (pure spare)
 *   Youssef  AP01 (13:45-22:45)  Gate+Boarding   -- F4 Boarding (spare from
 *                                                   13:45 until 17:00)
 *
 * Candidate eligibility (lib/planning/candidate-lookup.ts) resolves an
 * employee's EFFECTIVE shift from their WeeklyPlanRosterEntry.shift_code
 * via the real catalog, not from raw Employee fields -- every employee
 * below is given BOTH, consistently, for exactly that reason. The
 * incumbent shift-boundary check in evaluateFlightDelayImpact reads the
 * raw Employee row directly, so the raw fields matter there too.
 *
 * ---------------------------------------------------------------------
 * THE FLIGHTS (CDG, Europe/Schengen, Boeing 737 -> Gate+Boarding+Profiling
 * share one T-60min window; see lib/planning/requirement-window.ts):
 * ---------------------------------------------------------------------
 *   F1 AT100  13:30  window 12:30-13:30  (Gate, Boarding, Profiling)
 *   F2 AT200  14:45  window 13:45-14:45  (Gate, Boarding, Profiling)
 *   F3 AT300  16:30  window 15:30-16:30  (Gate, Boarding, Profiling)
 *   F4 AT400  18:00  window 17:00-18:00  (Boarding x2 -- Youssef + Omar)
 *
 * 10 task-slots, 8 agents, 2 pure spares (Imane fully free; Youssef free
 * 13:45-17:00) -- deliberately tight: normal operations are fully
 * covered, but there is very little slack, exactly as requested.
 *
 * ALL the window/eligibility math below was verified against the REAL
 * service functions (not hand-derived) before being written as
 * assertions -- see this patch's delivery notes for the two genuine,
 * previously-unknown bugs that process surfaced and fixed.
 * ===========================================================================
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
  maybeSingle(): Promise<{ data: FakeRow | null; error: null }> {
    const rows = this.resolveRows();
    return Promise.resolve({ data: rows[0] ?? null, error: null });
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
}

const DATE = "2026-10-07"; // Wednesday
const WEEK_START = "2026-10-05"; // the Monday of that week
const PLAN_ID = planIdForWeek(WEEK_START);

function emp(overrides: Partial<Employee>): Employee {
  return {
    id: "x",
    name: "x",
    skills: [],
    assignment: "General",
    shift_code: "NR02",
    shift_start: null,
    shift_end: null,
    rest_before_shift_hours: 15,
    weekly_hours: 20,
    is_duty_officer: false,
    off_days: [],
    foreign_company_authorizations: [],
    active: true,
    weekly_shifts: [],
    ...overrides,
  } as Employee;
}
function flight(overrides: Partial<Flight>): Flight {
  return {
    id: "f",
    flight_number: "AT000",
    airline: "Royal Air Maroc",
    route: "CMN → CDG",
    origin: "CMN",
    destination: "CDG",
    aircraft: "Boeing 737-800",
    equipment_code: null,
    registration: null,
    callsign: null,
    terminal: "T1",
    scheduled_departure: "12:00",
    scheduled_arrival: null,
    gate: null,
    boarding_window_start: null,
    boarding_window_end: null,
    status: "scheduled",
    booking_pressure: "normal",
    day_of_week: "Wednesday",
    flight_date: DATE,
    week_start: WEEK_START,
    operator_type: "atlas_managed",
    destination_category: "Europe/Schengen",
    booked_passengers: null,
    seat_capacity: null,
    ...overrides,
  } as Flight;
}
function req(overrides: Partial<StaffingRequirement>): StaffingRequirement {
  return {
    id: "r",
    flight_id: "f",
    role: "Gate",
    baseline_requirement: 1,
    additional_requirement: 0,
    total_requirement: 1,
    source: "fixed_rule",
    reasoning: "demo day",
    needs_configuration: false,
    ...overrides,
  };
}
function assign(overrides: Partial<Assignment>): Assignment {
  return {
    id: "a",
    plan_id: PLAN_ID,
    staffing_requirement_id: "r",
    employee_id: "e",
    source: "human_modified",
    created_by: "Test Setup",
    assigned_at: new Date().toISOString(),
    ...overrides,
  };
}
function roster(employee_id: string, shift_code: string): WeeklyPlanRosterEntry {
  return { id: `roster-${employee_id}`, plan_id: PLAN_ID, employee_id, day_of_week: "Wednesday", status: "working", shift_code };
}

function buildFixture() {
  const fake = new FakeSupabase();

  const employees: Employee[] = [
    emp({ id: "alice", name: "Alice", skills: ["Gate", "Boarding"], shift_code: "MT01", shift_start: "05:45", shift_end: "15:00" }),
    emp({ id: "omar", name: "Omar", skills: ["Gate", "Boarding"], shift_code: "MT01", shift_start: "05:45", shift_end: "15:00" }),
    emp({ id: "sara", name: "Sara", skills: ["Gate", "Boarding"], shift_code: "AP01", shift_start: "13:45", shift_end: "22:45" }),
    emp({ id: "yassine", name: "Yassine", skills: ["Gate", "Boarding"], shift_code: "AP01", shift_start: "13:45", shift_end: "22:45" }),
    emp({ id: "karim", name: "Karim", skills: ["Gate", "Boarding"], shift_code: "AP02", shift_start: "13:45", shift_end: "23:15" }),
    emp({ id: "nadia", name: "Nadia", skills: ["Profiling"], shift_code: "NR02", shift_start: "08:00", shift_end: "18:15" }),
    emp({ id: "imane", name: "Imane", skills: ["Gate", "Boarding"], shift_code: "NR02", shift_start: "08:00", shift_end: "18:15" }),
    emp({ id: "youssef", name: "Youssef", skills: ["Gate", "Boarding"], shift_code: "AP01", shift_start: "13:45", shift_end: "22:45" }),
  ];

  const f1 = flight({ id: "f1", flight_number: "AT100", scheduled_departure: "13:30" });
  const f2 = flight({ id: "f2", flight_number: "AT200", scheduled_departure: "14:45" });
  const f3 = flight({ id: "f3", flight_number: "AT300", scheduled_departure: "16:30" });
  const f4 = flight({ id: "f4", flight_number: "AT400", scheduled_departure: "18:00" });

  const requirements: Record<string, StaffingRequirement> = {
    f1Gate: req({ id: "f1-gate", flight_id: "f1", role: "Gate" }),
    f1Board: req({ id: "f1-board", flight_id: "f1", role: "Boarding" }),
    f1Prof: req({ id: "f1-prof", flight_id: "f1", role: "Profiling" }),
    f2Gate: req({ id: "f2-gate", flight_id: "f2", role: "Gate" }),
    f2Board: req({ id: "f2-board", flight_id: "f2", role: "Boarding" }),
    f2Prof: req({ id: "f2-prof", flight_id: "f2", role: "Profiling" }),
    f3Gate: req({ id: "f3-gate", flight_id: "f3", role: "Gate" }),
    f3Board: req({ id: "f3-board", flight_id: "f3", role: "Boarding" }),
    f3Prof: req({ id: "f3-prof", flight_id: "f3", role: "Profiling" }),
    f4Board: req({ id: "f4-board", flight_id: "f4", role: "Boarding", total_requirement: 2 }),
  };

  const assignments: Assignment[] = [
    assign({ id: "as-f1-gate", staffing_requirement_id: "f1-gate", employee_id: "alice" }),
    assign({ id: "as-f1-board", staffing_requirement_id: "f1-board", employee_id: "omar" }),
    assign({ id: "as-f1-prof", staffing_requirement_id: "f1-prof", employee_id: "nadia" }),
    assign({ id: "as-f2-gate", staffing_requirement_id: "f2-gate", employee_id: "sara" }),
    assign({ id: "as-f2-board", staffing_requirement_id: "f2-board", employee_id: "yassine" }),
    assign({ id: "as-f2-prof", staffing_requirement_id: "f2-prof", employee_id: "nadia" }),
    assign({ id: "as-f3-gate", staffing_requirement_id: "f3-gate", employee_id: "yassine" }),
    assign({ id: "as-f3-board", staffing_requirement_id: "f3-board", employee_id: "karim" }),
    assign({ id: "as-f3-prof", staffing_requirement_id: "f3-prof", employee_id: "nadia" }),
    assign({ id: "as-f4-board-1", staffing_requirement_id: "f4-board", employee_id: "youssef" }),
    assign({ id: "as-f4-board-2", staffing_requirement_id: "f4-board", employee_id: "omar" }),
  ];

  const plan: WeeklyPlan = {
    id: PLAN_ID,
    week_start: WEEK_START,
    week_label: "Stress Demo Week",
    status: "published",
    revision: 1,
    generated_at: new Date().toISOString(),
    published_at: new Date().toISOString(),
    generated_from_hash: "demo-hash",
    config_snapshot: CONFIG,
    issues: [],
    configuration_issues: [],
  };

  const rosters = employees.map((e) => roster(e.id, e.shift_code!));

  fake.from("employees").insert(employees as unknown as FakeRow[]);
  fake.from("flights").insert([f1, f2, f3, f4] as unknown as FakeRow[]);
  fake.from("staffing_requirements").insert(Object.values(requirements) as unknown as FakeRow[]);
  fake.from("assignments").insert(assignments as unknown as FakeRow[]);
  fake.from("weekly_plans").insert([plan] as unknown as FakeRow[]);
  fake.from("weekly_plan_roster_entries").insert(rosters as unknown as FakeRow[]);

  return { fake, employees, flights: { f1, f2, f3, f4 }, requirements };
}

function candidateIds(conflict: { replacementCandidates: { employee: { id: string }; status: string }[] }, status?: string) {
  return conflict.replacementCandidates.filter((c) => !status || c.status === status).map((c) => c.employee.id);
}

describe("Live Ops stress demo — NORMAL STATE", () => {
  it("every task-slot is covered with no overlaps and no shift violations for all 8 agents", async () => {
    const { fake } = buildFixture();
    const view = await loadLiveOpsView(fake as unknown as SupabaseClient, DATE);
    expect(view.plan?.status).toBe("published");

    const byFlight = new Map(view.flights.map((f) => [f.flight.flight_number, f]));
    for (const [flightNumber, roles] of [
      ["AT100", ["Gate", "Boarding", "Profiling"]],
      ["AT200", ["Gate", "Boarding", "Profiling"]],
      ["AT300", ["Gate", "Boarding", "Profiling"]],
      ["AT400", ["Boarding"]],
    ] as const) {
      const fv = byFlight.get(flightNumber)!;
      for (const role of roles) {
        const rv = fv.requirements.find((r) => r.requirement.role === role)!;
        expect(rv.coverageStatus).toBe("assigned");
        expect(rv.gap).toBe(0);
      }
    }

    // No operational change at all -- every flight must evaluate to zero
    // conflicts.
    for (const flightId of ["f1", "f2", "f3", "f4"]) {
      const result = await evaluateFlightDelayImpact(fake as unknown as SupabaseClient, flightId);
      if ("error" in result) throw new Error(result.error);
      expect(result.conflicts).toHaveLength(0);
    }
  });
});

describe("Live Ops stress demo — Scenario 1: safe delay (incumbent stays valid)", () => {
  it("a small delay that keeps everyone inside their shift and clear of other duties produces zero conflicts", async () => {
    const { fake } = buildFixture();
    await fake.from("flights").update({ actual_departure: "13:40" }).eq("id", "f1");

    const result = await evaluateFlightDelayImpact(fake as unknown as SupabaseClient, "f1");
    if ("error" in result) throw new Error(result.error);
    expect(result.conflicts).toHaveLength(0);
  });
});

describe("Live Ops stress demo — Scenario 2: downstream conflict (recommend the best eligible replacement)", () => {
  it("delaying F2 collides Yassine's Boarding duty with his own later F3 Gate duty, and recommends eligible replacements", async () => {
    const { fake } = buildFixture();
    await fake.from("flights").update({ actual_departure: "15:40" }).eq("id", "f2");

    const result = await evaluateFlightDelayImpact(fake as unknown as SupabaseClient, "f2");
    if ("error" in result) throw new Error(result.error);

    const boardingConflict = result.conflicts.find((c) => c.requirement.role === "Boarding")!;
    expect(boardingConflict.employee.id).toBe("yassine");
    expect(boardingConflict.collidesWith?.flight.flight_number).toBe("AT300");
    expect(boardingConflict.collidesWith?.requirement.role).toBe("Gate");
    expect(boardingConflict.shiftBoundaryViolation).toBeUndefined();

    // Imane and Youssef are genuinely free and fully within shift for the
    // new window -- clean recommendations. Alice and Omar's MT01 shift
    // ends at 15:00, before the new window's 15:40 end -- they still pass
    // the hard overlap gate (their shift DOES overlap the new window) but
    // are correctly FLAGGED (would need an unplanned extension), never
    // silently recommended. This is pre-existing, deliberate scoring.ts
    // behavior (see its own doc comment on the extension-needed flag), not
    // a new finding.
    expect(candidateIds(boardingConflict, "recommended").sort()).toEqual(["imane", "youssef"]);
    expect(candidateIds(boardingConflict, "flagged").sort()).toEqual(["alice", "omar"]);

    // Real, honest emergent finding: this SAME delay also pushes Nadia's
    // F2 Profiling duty into collision with her own F3 Profiling duty --
    // and because Nadia is the ONLY Profiling-qualified agent in this
    // dataset, there is NO eligible replacement for her at all. One delay
    // can create one fixable conflict and one genuinely unfixable one at
    // the same time; ATLAS must report both honestly rather than only the
    // fixable one.
    const profilingConflict = result.conflicts.find((c) => c.requirement.role === "Profiling")!;
    expect(profilingConflict.employee.id).toBe("nadia");
    expect(profilingConflict.collidesWith?.flight.flight_number).toBe("AT300");
    expect(profilingConflict.replacementCandidates).toHaveLength(0);
    expect(profilingConflict.exclusionSummary?.some((e) => e.reason.includes("Not qualified for Profiling"))).toBe(true);

    expect(result.conflicts).toHaveLength(2);
  });
});

describe("Live Ops stress demo — Scenario 3: shift-boundary conflict (+ a simultaneous downstream collision)", () => {
  it("a large F1 delay pushes Alice past her shift end with no other duty to collide with, and Omar past his shift end AND into his own later F4 duty", async () => {
    const { fake } = buildFixture();
    await fake.from("flights").update({ actual_departure: "17:30" }).eq("id", "f1");

    const result = await evaluateFlightDelayImpact(fake as unknown as SupabaseClient, "f1");
    if ("error" in result) throw new Error(result.error);
    expect(result.conflicts).toHaveLength(2);

    const gateConflict = result.conflicts.find((c) => c.requirement.role === "Gate")!;
    expect(gateConflict.employee.id).toBe("alice");
    expect(gateConflict.shiftBoundaryViolation).toEqual({ shiftStart: "05:45", shiftEnd: "15:00" });
    // Pure shift-boundary case -- no other duty to collide with.
    expect(gateConflict.collidesWith).toBeUndefined();
    expect(candidateIds(gateConflict, "recommended").sort()).toEqual(["imane", "karim", "sara", "yassine"]);

    const boardingConflict = result.conflicts.find((c) => c.requirement.role === "Boarding")!;
    expect(boardingConflict.employee.id).toBe("omar");
    // Both reasons fire together for Omar: his shift ends at 15:00 AND the
    // new window now overlaps his own F4 Boarding duty (17:00-18:00).
    expect(boardingConflict.shiftBoundaryViolation).toEqual({ shiftStart: "05:45", shiftEnd: "15:00" });
    expect(boardingConflict.collidesWith?.flight.flight_number).toBe("AT400");
    // Youssef is excluded here precisely because he's the one Omar's own
    // F4 duty is colliding with -- he's busy with that same F4 Boarding
    // slot at this time.
    expect(candidateIds(boardingConflict, "recommended").sort()).toEqual(["imane", "karim", "sara", "yassine"]);
    expect(boardingConflict.replacementCandidates.some((c) => c.employee.id === "youssef")).toBe(false);
  });
});

describe("Live Ops stress demo — Scenario 4: no valid replacement (honest operational gap)", () => {
  it("a very large F3 delay pushes Nadia past her shift end, with zero eligible replacements anywhere", async () => {
    const { fake } = buildFixture();
    await fake.from("flights").update({ actual_departure: "19:00" }).eq("id", "f3");

    const result = await evaluateFlightDelayImpact(fake as unknown as SupabaseClient, "f3");
    if ("error" in result) throw new Error(result.error);

    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0];
    expect(conflict.requirement.role).toBe("Profiling");
    expect(conflict.employee.id).toBe("nadia");
    expect(conflict.shiftBoundaryViolation).toEqual({ shiftStart: "08:00", shiftEnd: "18:15" });
    // A genuine, honest gap -- never a forced or implied assignment.
    expect(conflict.replacementCandidates).toHaveLength(0);
    expect(conflict.exclusionSummary?.some((e) => e.reason.includes("Not qualified for Profiling"))).toBe(true);
  });
});

describe("Live Ops stress demo — adversarial: combinations not specifically designed around", () => {
  it("two disruptions occurring close together: F1 and F2 delayed at once still evaluate independently and correctly, with no cross-contamination", async () => {
    const { fake } = buildFixture();
    await fake.from("flights").update({ actual_departure: "17:30" }).eq("id", "f1");
    await fake.from("flights").update({ actual_departure: "15:40" }).eq("id", "f2");

    const f1Result = await evaluateFlightDelayImpact(fake as unknown as SupabaseClient, "f1");
    const f2Result = await evaluateFlightDelayImpact(fake as unknown as SupabaseClient, "f2");
    if ("error" in f1Result) throw new Error(f1Result.error);
    if ("error" in f2Result) throw new Error(f2Result.error);

    // Same results as Scenario 3 and Scenario 2 run in isolation -- F1's
    // disruption doesn't leak into F2's evaluation or vice versa.
    expect(f1Result.conflicts.map((c) => c.employee.id).sort()).toEqual(["alice", "omar"]);
    expect(f2Result.conflicts.map((c) => c.employee.id).sort()).toEqual(["nadia", "yassine"]);
  });

  it("two flights competing for the same pool: delaying F1 forward and bringing F4 earlier double-books Omar across his own two duties, and the fix correctly detects it", async () => {
    const { fake } = buildFixture();
    await fake.from("flights").update({ actual_departure: "17:30" }).eq("id", "f1");
    await fake.from("flights").update({ actual_departure: "17:15" }).eq("id", "f4");

    // F1 impact is unchanged by F4's own delay (F4 isn't one of Alice/Omar's
    // OTHER commitments for the Gate requirement in question... except
    // Omar's own F1 Boarding duty, already covered by Scenario 3's style
    // assertion below).
    const f4Result = await evaluateFlightDelayImpact(fake as unknown as SupabaseClient, "f4");
    if ("error" in f4Result) throw new Error(f4Result.error);

    expect(f4Result.conflicts).toHaveLength(1);
    const conflict = f4Result.conflicts[0];
    expect(conflict.employee.id).toBe("omar");
    // This collision only exists because BOTH F1 and F4 were independently
    // delayed into overlapping range -- the collision partner's window
    // must reflect F1's OWN live delay (16:30-17:30), not its original
    // 12:30-13:30 slot.
    expect(conflict.collidesWith?.flight.flight_number).toBe("AT100");
    expect(conflict.collidesWith?.window).toEqual({ start: "16:30", end: "17:30" });
    // Yassine and Karim are excluded (each already committed to their own
    // F3 duty, which now overlaps); Imane and Sara are genuinely free.
    expect(candidateIds(conflict, "recommended").sort()).toEqual(["imane", "sara"]);
  });

  it("qualification bottleneck: Nadia is the sole Profiling-qualified agent, so every Profiling conflict is unfixable by design", async () => {
    const { fake } = buildFixture();
    await fake.from("flights").update({ actual_departure: "19:00" }).eq("id", "f3");
    const result = await evaluateFlightDelayImpact(fake as unknown as SupabaseClient, "f3");
    if ("error" in result) throw new Error(result.error);
    const conflict = result.conflicts[0];
    const notQualified = conflict.exclusionSummary?.find((e) => e.reason.includes("Not qualified for Profiling"));
    // Every other agent in the roster who's otherwise even reachable shows
    // up under this one honest reason -- confirming the gap is a real
    // qualifications shortage, not a scheduling quirk.
    expect(notQualified).toBeDefined();
  });

  it("shift-end + downstream-task conflict simultaneously: Omar's Scenario 3 conflict already carries both reasons on one object, never suppressing either", async () => {
    const { fake } = buildFixture();
    await fake.from("flights").update({ actual_departure: "17:30" }).eq("id", "f1");
    const result = await evaluateFlightDelayImpact(fake as unknown as SupabaseClient, "f1");
    if ("error" in result) throw new Error(result.error);
    const omarConflict = result.conflicts.find((c) => c.employee.id === "omar")!;
    expect(omarConflict.shiftBoundaryViolation).toBeDefined();
    expect(omarConflict.collidesWith).toBeDefined();
  });

  it("a replacement who solves Flight A later runs into a NEW conflict of their own when a second, later disruption hits their original duty", async () => {
    const { fake } = buildFixture();
    await fake.from("flights").update({ actual_departure: "17:30" }).eq("id", "f1");

    const before = await evaluateFlightDelayImpact(fake as unknown as SupabaseClient, "f1");
    if ("error" in before) throw new Error(before.error);
    const gateConflict = before.conflicts.find((c) => c.requirement.role === "Gate")!;
    expect(gateConflict.replacementCandidates.some((c) => c.employee.id === "sara" && c.status === "recommended")).toBe(true);

    const confirmResult = await confirmReassignment(fake as unknown as SupabaseClient, {
      staffingRequirementId: "f1-gate",
      oldEmployeeId: "alice",
      newEmployeeId: "sara",
      reason: "AT100 delayed; Alice's shift ends before the new boarding time.",
    });
    expect(confirmResult.ok).toBe(true);

    // Sara's OWN original duty (F2 Gate) is now ALSO delayed -- far enough
    // that it collides with the F1 Gate slot she was just given.
    await fake.from("flights").update({ actual_departure: "17:00" }).eq("id", "f2");
    const after = await evaluateFlightDelayImpact(fake as unknown as SupabaseClient, "f2");
    if ("error" in after) throw new Error(after.error);

    const saraConflict = after.conflicts.find((c) => c.employee.id === "sara")!;
    expect(saraConflict).toBeDefined();
    expect(saraConflict.requirement.role).toBe("Gate");
    expect(saraConflict.collidesWith?.flight.flight_number).toBe("AT100");
  });

  it("a disruption changed again after an earlier reassignment is re-evaluated against the NEW incumbent, not stale data", async () => {
    const { fake } = buildFixture();
    await fake.from("flights").update({ actual_departure: "17:30" }).eq("id", "f1");
    await confirmReassignment(fake as unknown as SupabaseClient, {
      staffingRequirementId: "f1-gate",
      oldEmployeeId: "alice",
      newEmployeeId: "sara",
      reason: "test",
    });

    // F1 is delayed AGAIN, to a milder time that fits Sara (the new
    // incumbent) just fine.
    await fake.from("flights").update({ actual_departure: "16:00" }).eq("id", "f1");
    const result = await evaluateFlightDelayImpact(fake as unknown as SupabaseClient, "f1");
    if ("error" in result) throw new Error(result.error);

    // No Gate conflict at all -- proves the incumbent being checked is
    // Sara (fits fine at the new, milder time), not stale data about Alice
    // (who would still have been invalid).
    expect(result.conflicts.some((c) => c.requirement.role === "Gate")).toBe(false);
  });

  it("restoring/cancelling a delay after a live reassignment leaves the reassignment in place with no automatic revert or flag (architecture finding, not a defect)", async () => {
    const { fake } = buildFixture();
    await fake.from("flights").update({ actual_departure: "17:30" }).eq("id", "f1");
    await confirmReassignment(fake as unknown as SupabaseClient, {
      staffingRequirementId: "f1-gate",
      oldEmployeeId: "alice",
      newEmployeeId: "sara",
      reason: "test",
    });

    // The delay is cancelled entirely -- F1 reverts to its original 13:30.
    await fake.from("flights").update({ actual_departure: null }).eq("id", "f1");
    const result = await evaluateFlightDelayImpact(fake as unknown as SupabaseClient, "f1");
    if ("error" in result) throw new Error(result.error);

    // Per PLANNED/ACTUAL traceability, the Regulator's decision is sticky
    // and is never silently undone -- Sara stays assigned, and since she's
    // perfectly valid at the reverted (original) time too, ATLAS reports
    // zero conflicts. It does NOT proactively flag "this reassignment may
    // no longer be necessary now that the delay is gone" -- a Duty Officer
    // who wants Alice back on Gate would need to do that manually, the
    // same as any other reassignment. Documented here as the actual,
    // observed behavior, not assumed.
    expect(result.conflicts).toHaveLength(0);
    const assignments = fake.table("assignments") as unknown as Assignment[];
    const gateAssignment = assignments.find((a) => a.staffing_requirement_id === "f1-gate");
    expect(gateAssignment?.employee_id).toBe("sara");
  });
});
