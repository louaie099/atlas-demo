import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CONFIG } from "../lib/seed-data";
import { planIdForWeek } from "../lib/planning/weekly-plan-service";
import { loadLiveOpsView, evaluateFlightDelayImpact, confirmReassignment } from "../lib/live-ops-service";
import { deriveFlightState } from "../lib/live-ops-flight-state";
import { groupFlights } from "../lib/live-ops-board";
import { buildDelayImpactNotification } from "../lib/live-ops-notifications";
import { Assignment, Employee, Flight, StaffingRequirement, WeeklyPlan, WeeklyPlanRosterEntry } from "../lib/types";

/**
 * Focused coverage for the 2026-10-06 Live Operations redesign (patch
 * 0093): the workforce summary feeding the new header's counters, the
 * Planned/Operational traceability line a requirement carries after a
 * reassignment, the exception-based board grouping, and the aggregated
 * notification built from a delay's impact — an AT815-shaped scenario
 * (one flight delayed, a conflict created, resolved via replacement),
 * exercising the exact same service-layer functions the new UI calls.
 * Reuses tests/live-ops-service.test.ts's own fake-Supabase harness
 * rather than inventing a second one.
 */

interface FakeRow {
  [key: string]: unknown;
}

// Mirrors tests/live-ops-service.test.ts's own fake Supabase exactly
// (eq/in/order/limit/range/single/maybeSingle) -- loadPersistedPlanView
// (via loadLiveOpsView) needs the FULL set, not a trimmed-down copy.
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

const WEEK_START = "2026-09-07"; // a Monday
const PLAN_ID = planIdForWeek(WEEK_START);

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "emp-x",
    name: "Test Employee",
    skills: ["Gate", "Boarding"],
    assignment: "General",
    shift_code: "MT03",
    shift_start: "05:45",
    shift_end: "14:45",
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
    flight_number: "AT815",
    airline: "Royal Air Maroc",
    route: "CMN → DKR",
    origin: "CMN",
    destination: "DKR",
    aircraft: "Boeing 787-9",
    equipment_code: null,
    registration: null,
    callsign: null,
    terminal: "T1",
    scheduled_departure: "13:45",
    scheduled_arrival: null,
    gate: "E01",
    boarding_window_start: null,
    boarding_window_end: null,
    status: "scheduled",
    booking_pressure: "normal",
    day_of_week: "Monday",
    flight_date: WEEK_START,
    week_start: WEEK_START,
    operator_type: "atlas_managed",
    destination_category: "Africa",
    booked_passengers: null,
    seat_capacity: null,
    ...overrides,
  };
}

function makeRequirement(overrides: Partial<StaffingRequirement>): StaffingRequirement {
  return {
    id: "req-x",
    flight_id: "flight-x",
    role: "Gate",
    baseline_requirement: 1,
    additional_requirement: 0,
    total_requirement: 1,
    source: "fixed_rule",
    reasoning: "test fixture",
    needs_configuration: false,
    ...overrides,
  };
}

function seedAt815Fixture(fake: FakeSupabase) {
  // Marouane: MT03 05:45-14:45, originally on AT815 Gate 12:15-13:45.
  const marouane = makeEmployee({ id: "emp-marouane", name: "Marouane Benali", shift_code: "MT03", shift_start: "05:45", shift_end: "14:45" });
  // Youssef: a later shift that actually covers AT815's post-delay Gate window.
  const youssef = makeEmployee({ id: "emp-youssef", name: "Youssef", shift_code: "AP01", shift_start: "13:45", shift_end: "22:45" });

  const at815 = makeFlight({ id: "flight-at815", flight_number: "AT815", scheduled_departure: "13:45" });
  const reqGate = makeRequirement({ id: "req-gate", flight_id: "flight-at815", role: "Gate" });

  const assign: Assignment = {
    id: "assign-gate",
    plan_id: PLAN_ID,
    staffing_requirement_id: "req-gate",
    employee_id: "emp-marouane",
    source: "atlas_generated",
    created_by: null,
    assigned_at: new Date().toISOString(),
  };

  const plan: WeeklyPlan = {
    id: PLAN_ID,
    week_start: WEEK_START,
    week_label: "Test Week",
    status: "draft",
    revision: 1,
    generated_at: new Date().toISOString(),
    published_at: null,
    generated_from_hash: "test-hash",
    config_snapshot: CONFIG,
    issues: [],
    configuration_issues: [],
  };

  const rosterMarouane: WeeklyPlanRosterEntry = { id: "roster-marouane", plan_id: PLAN_ID, employee_id: "emp-marouane", day_of_week: "Monday", status: "working", shift_code: "MT03" };
  const rosterYoussef: WeeklyPlanRosterEntry = { id: "roster-youssef", plan_id: PLAN_ID, employee_id: "emp-youssef", day_of_week: "Monday", status: "working", shift_code: "AP01" };

  fake.from("employees").insert([marouane, youssef] as unknown as FakeRow[]);
  fake.from("flights").insert([at815] as unknown as FakeRow[]);
  fake.from("staffing_requirements").insert([reqGate] as unknown as FakeRow[]);
  fake.from("assignments").insert([assign] as unknown as FakeRow[]);
  fake.from("weekly_plans").insert([plan] as unknown as FakeRow[]);
  fake.from("weekly_plan_roster_entries").insert([rosterMarouane, rosterYoussef] as unknown as FakeRow[]);

  return { marouane, youssef, at815, reqGate };
}

describe("Live Operations redesign — AT815 delay scenario end to end", () => {
  it("workforce summary reflects working/assigned/available for the viewed date", async () => {
    const fake = new FakeSupabase();
    seedAt815Fixture(fake);

    const view = await loadLiveOpsView(fake as unknown as SupabaseClient, WEEK_START);
    expect(view.workforce.workingToday).toBe(2); // Marouane + Youssef both working Monday
    expect(view.workforce.assignedToday).toBe(1); // only Marouane holds a duty
    expect(view.workforce.availableToday).toBe(1); // Youssef, free all day
  });

  it("a 13:45 -> 18:45 delay creates a Gate conflict, groups the flight into Needs Attention, and produces one aggregated notification", async () => {
    const fake = new FakeSupabase();
    seedAt815Fixture(fake);

    await fake.from("flights").update({ actual_departure: "18:45" }).eq("id", "flight-at815");

    const impactResult = await evaluateFlightDelayImpact(fake as unknown as SupabaseClient, "flight-at815");
    if ("error" in impactResult) throw new Error(impactResult.error);
    expect(impactResult.conflicts).toHaveLength(1);
    expect(impactResult.conflicts[0].employee.id).toBe("emp-marouane");
    expect(impactResult.conflicts[0].shiftBoundaryViolation).toEqual({ shiftStart: "05:45", shiftEnd: "14:45" });
    expect(impactResult.conflicts[0].replacementCandidates.some((c) => c.employee.id === "emp-youssef")).toBe(true);

    // Exactly one aggregated notification, not one per conflict.
    const notification = buildDelayImpactNotification(impactResult.flight, impactResult);
    expect(notification).not.toBeNull();
    expect(notification!.title).toContain("AT815");
    expect(notification!.detail).toContain("1 assignment conflict");
    expect(notification!.requirementIds).toEqual(["req-gate"]);

    const view = await loadLiveOpsView(fake as unknown as SupabaseClient, WEEK_START);
    const flightView = view.flights.find((f) => f.flight.id === "flight-at815")!;
    const state = deriveFlightState(flightView, /* hasActiveConflict */ true);
    expect(state).toBe("conflict");

    const grouped = groupFlights([flightView], () => state, 0);
    expect(grouped.needsAttention.map((f) => f.flight.id)).toEqual(["flight-at815"]);
  });

  it("confirming the replacement resolves the conflict and leaves a Planned/Operational trace on the requirement", async () => {
    const fake = new FakeSupabase();
    seedAt815Fixture(fake);
    await fake.from("flights").update({ actual_departure: "18:45" }).eq("id", "flight-at815");
    await fake.from("audit_log_entries").insert({ id: "audit-0", step_number: 0, description: "seed" });

    const confirmResult = await confirmReassignment(fake as unknown as SupabaseClient, {
      staffingRequirementId: "req-gate",
      oldEmployeeId: "emp-marouane",
      newEmployeeId: "emp-youssef",
      reason: "AT815 delayed to 18:45; Marouane's MT03 shift ends before the new Gate window.",
    });
    expect(confirmResult.ok).toBe(true);

    // The conflict is gone post-replacement...
    const postImpact = await evaluateFlightDelayImpact(fake as unknown as SupabaseClient, "flight-at815");
    if ("error" in postImpact) throw new Error(postImpact.error);
    expect(postImpact.conflicts).toHaveLength(0);

    // ...and the requirement now carries the Planned-vs-Operational trace
    // the redesign's drawer reads directly (section 12).
    const view = await loadLiveOpsView(fake as unknown as SupabaseClient, WEEK_START);
    const flightView = view.flights.find((f) => f.flight.id === "flight-at815")!;
    const reqView = flightView.requirements.find((r) => r.requirement.id === "req-gate")!;
    expect(reqView.assignedEmployees.map((e) => e.id)).toEqual(["emp-youssef"]);
    expect(reqView.modification).toEqual({
      previousEmployeeName: "Marouane Benali",
      newEmployeeName: "Youssef",
      changedAt: expect.any(String),
      changedBy: "Mohammed Alaoui",
      reason: "AT815 delayed to 18:45; Marouane's MT03 shift ends before the new Gate window.",
    });

    // The flight is still operationally delayed (effectiveDeparture !==
    // scheduled_departure) even though coverage is now resolved -- "delayed"
    // is the correct state here, not "covered" (see deriveFlightState's own
    // priority order: Conflict > Gap > Delayed > Covered).
    const state = deriveFlightState(flightView, false);
    expect(state).toBe("delayed");
  });
});
