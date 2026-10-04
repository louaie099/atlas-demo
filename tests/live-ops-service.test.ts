import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CONFIG } from "../lib/seed-data";
import { planIdForWeek } from "../lib/planning/weekly-plan-service";
import { getCandidatesForRequirement } from "../lib/planning/candidate-lookup";
import { loadLiveOpsView, evaluateFlightDelayImpact, confirmReassignment } from "../lib/live-ops-service";
import { effectiveDeparture } from "../lib/flight-operations";
import { Assignment, AssignmentModification, Employee, Flight, StaffingRequirement, WeeklyPlan, WeeklyPlanRosterEntry } from "../lib/types";

/**
 * A capable-enough fake Supabase for the live-ops service layer: extends
 * the chainable-select pattern already used by
 * tests/weekly-plan-lifecycle.test.ts (eq/in/range) with `.single()` and
 * `.order()/.limit()`, which lib/planning/candidate-lookup.ts and
 * lib/live-ops-service.ts both use and weekly-plan-service.ts's own
 * fake never needed to support.
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
    // Not exercised by anything limit/order-based in this suite's calls,
    // but kept for parity with fetchAllRosterEntriesForPlan's pagination.
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

// ---------------------------------------------------------------------------
// Fixture: two employees, two flights, two requirements, both initially
// assigned to the SAME employee (empA) on the same day, built so their
// windows do NOT collide until flight-1 is operationally delayed.
// ---------------------------------------------------------------------------

const WEEK_START = "2026-09-07"; // a Monday, deliberately NOT CURRENT_WEEK_START
const PLAN_ID = planIdForWeek(WEEK_START);

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "emp-x",
    name: "Test Employee",
    skills: ["Boarding", "Gate"],
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
    flight_number: "AT999",
    airline: "Royal Air Maroc",
    route: "CMN → XXX",
    origin: "CMN",
    destination: "XXX",
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

function makeRequirement(overrides: Partial<StaffingRequirement>): StaffingRequirement {
  return {
    id: "req-x",
    flight_id: "flight-x",
    role: "Boarding",
    baseline_requirement: 1,
    additional_requirement: 0,
    total_requirement: 1,
    source: "fixed_rule",
    reasoning: "test fixture",
    needs_configuration: false,
    ...overrides,
  };
}

function seedBaseFixture(fake: FakeSupabase) {
  const empA = makeEmployee({ id: "emp-a", name: "Employee A" });
  const empB = makeEmployee({ id: "emp-b", name: "Employee B" });

  // flight-1: Boarding requirement, departs 09:00 -> window 08:00-09:00.
  const flight1 = makeFlight({ id: "flight-1", flight_number: "AT301", scheduled_departure: "09:00" });
  // flight-2: Gate requirement, departs 11:00 -> window 10:00-11:00.
  const flight2 = makeFlight({ id: "flight-2", flight_number: "AT302", scheduled_departure: "11:00" });

  const req1 = makeRequirement({ id: "req-1", flight_id: "flight-1", role: "Boarding" });
  const req2 = makeRequirement({ id: "req-2", flight_id: "flight-2", role: "Gate" });

  const assign1: Assignment = {
    id: "assign-1",
    plan_id: PLAN_ID,
    staffing_requirement_id: "req-1",
    employee_id: "emp-a",
    source: "human_modified",
    created_by: "Test Setup",
    assigned_at: new Date().toISOString(),
  };
  const assign2: Assignment = {
    id: "assign-2",
    plan_id: PLAN_ID,
    staffing_requirement_id: "req-2",
    employee_id: "emp-a",
    source: "human_modified",
    created_by: "Test Setup",
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

  const rosterA: WeeklyPlanRosterEntry = { id: "roster-a", plan_id: PLAN_ID, employee_id: "emp-a", day_of_week: "Monday", status: "working", shift_code: "NR02" };
  const rosterB: WeeklyPlanRosterEntry = { id: "roster-b", plan_id: PLAN_ID, employee_id: "emp-b", day_of_week: "Monday", status: "working", shift_code: "NR02" };

  fake.from("employees").insert([empA, empB] as unknown as FakeRow[]);
  fake.from("flights").insert([flight1, flight2] as unknown as FakeRow[]);
  fake.from("staffing_requirements").insert([req1, req2] as unknown as FakeRow[]);
  fake.from("assignments").insert([assign1, assign2] as unknown as FakeRow[]);
  fake.from("weekly_plans").insert([plan] as unknown as FakeRow[]);
  fake.from("weekly_plan_roster_entries").insert([rosterA, rosterB] as unknown as FakeRow[]);

  return { empA, empB, flight1, flight2, req1, req2 };
}

describe("lib/flight-operations — effectiveDeparture", () => {
  it("falls back to scheduled_departure when actual_departure is null/unset", () => {
    const flight = makeFlight({ scheduled_departure: "09:00" });
    expect(effectiveDeparture(flight)).toBe("09:00");
    expect(effectiveDeparture({ ...flight, actual_departure: null })).toBe("09:00");
  });

  it("prefers actual_departure once set, without mutating scheduled_departure", () => {
    const flight = makeFlight({ scheduled_departure: "09:00", actual_departure: "10:30" });
    expect(effectiveDeparture(flight)).toBe("10:30");
    expect(flight.scheduled_departure).toBe("09:00");
  });
});

describe("candidate-lookup — week-derivation bug fix", () => {
  it("derives the plan week from the requirement's OWN flight, not a fixed global week constant", async () => {
    const fake = new FakeSupabase();
    seedBaseFixture(fake);

    // req-2 (Gate, flight-2) has no existing assignment conflict in this
    // call's path -- emp-b should come back as a real candidate, proving
    // the plan for WEEK_START (which is NOT CURRENT_WEEK_START) was
    // found and used.
    const result = await getCandidatesForRequirement(fake as unknown as SupabaseClient, "req-1", { excludeEmployeeIds: ["emp-a"] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.candidates.some((c) => c.employee.id === "emp-b")).toBe(true);
  });
});

describe("live-ops-service — loadLiveOpsView", () => {
  it("returns { flights: [], plan: null } when no plan exists at all for the date's week", async () => {
    const fake = new FakeSupabase();
    const view = await loadLiveOpsView(fake as unknown as SupabaseClient, "2026-09-07");
    expect(view.plan).toBeNull();
    expect(view.flights).toEqual([]);
  });

  it("returns real flights/requirements/assignments for the date, scoped from the persisted plan", async () => {
    const fake = new FakeSupabase();
    seedBaseFixture(fake);

    const view = await loadLiveOpsView(fake as unknown as SupabaseClient, WEEK_START);
    expect(view.plan).not.toBeNull();
    expect(view.plan!.status).toBe("draft");
    expect(view.flights.map((f) => f.flight.id).sort()).toEqual(["flight-1", "flight-2"]);

    const flight1View = view.flights.find((f) => f.flight.id === "flight-1")!;
    expect(flight1View.effectiveDeparture).toBe("09:00"); // no actual_departure set yet
    expect(flight1View.requirements).toHaveLength(1);
    expect(flight1View.requirements[0].assignedEmployees.map((e) => e.id)).toEqual(["emp-a"]);
    expect(flight1View.requirements[0].proposedEmployees).toEqual([]);
    expect(flight1View.requirements[0].coverageStatus).toBe("assigned");
  });

  it("returns non-empty proposedEmployees for a draft plan's engine-only ('atlas_generated') coverage, and keeps assignedEmployees to the real-Assignment-backed set only", async () => {
    const fake = new FakeSupabase();
    const { empB } = seedBaseFixture(fake);

    // req-2/flight-2 already has emp-a as a real (human_modified)
    // assignment from the base fixture -- add a SECOND seat on it,
    // covered only by the engine's own draft-plan pick (atlas_generated),
    // never backed by a real Assignment row distinction other than
    // `source`.
    const reqs = fake.table("staffing_requirements") as unknown as StaffingRequirement[];
    const req2 = reqs.find((r) => r.id === "req-2")!;
    req2.total_requirement = 2;

    await fake.from("assignments").insert({
      id: "assign-3",
      plan_id: PLAN_ID,
      staffing_requirement_id: "req-2",
      employee_id: "emp-b",
      source: "atlas_generated",
      created_by: null,
      assigned_at: new Date().toISOString(),
    });

    const view = await loadLiveOpsView(fake as unknown as SupabaseClient, WEEK_START);
    const flight2View = view.flights.find((f) => f.flight.id === "flight-2")!;
    const req2View = flight2View.requirements.find((r) => r.requirement.id === "req-2")!;

    // The real, human-attributable assignment stays exactly where it was...
    expect(req2View.assignedEmployees.map((e) => e.id)).toEqual(["emp-a"]);
    // ...and the engine's own draft-plan pick shows up SEPARATELY as
    // proposedEmployees, never merged into or confused with assignedEmployees.
    expect(req2View.proposedEmployees.map((e) => e.id)).toEqual([empB.id]);
    expect(req2View.coverageStatus).toBe("assigned"); // 1 assigned + 1 proposed >= total_requirement 2
  });
});

describe("live-ops-service — evaluateFlightDelayImpact (conflict detection)", () => {
  it("detects no conflict before any operational change", async () => {
    const fake = new FakeSupabase();
    seedBaseFixture(fake);

    const result = await evaluateFlightDelayImpact(fake as unknown as SupabaseClient, "flight-1");
    if ("error" in result) throw new Error(result.error);
    expect(result.conflicts).toHaveLength(0);
  });

  it("detects a real conflict once the delayed flight's new window collides with the employee's other same-day assignment, and recommends an eligible replacement", async () => {
    const fake = new FakeSupabase();
    seedBaseFixture(fake);

    // Operationally delay flight-1 from 09:00 to 10:30 -- its Boarding
    // window becomes 09:30-10:30, now colliding with flight-2's Gate
    // window (10:00-11:00), both held by emp-a.
    await fake.from("flights").update({ actual_departure: "10:30" }).eq("id", "flight-1");

    const result = await evaluateFlightDelayImpact(fake as unknown as SupabaseClient, "flight-1");
    if ("error" in result) throw new Error(result.error);

    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0];
    expect(conflict.requirement.id).toBe("req-1");
    expect(conflict.employee.id).toBe("emp-a");
    expect(conflict.oldWindow).toEqual({ start: "08:00", end: "09:00" });
    expect(conflict.newWindow).toEqual({ start: "09:30", end: "10:30" });
    expect(conflict.collidesWith?.requirement.id).toBe("req-2");
    expect(conflict.shiftBoundaryViolation).toBeUndefined();

    // emp-b is free all day and qualified for Boarding -- a real eligible
    // replacement, never a forced/invalid one.
    expect(conflict.replacementCandidates.some((c) => c.employee.id === "emp-b")).toBe(true);
    expect(conflict.replacementCandidates.some((c) => c.employee.id === "emp-a")).toBe(false);
  });

  it("reports an honest empty replacement list (never a forced invalid assignment) when no one else is eligible", async () => {
    const fake = new FakeSupabase();
    seedBaseFixture(fake);
    // Make emp-b ineligible for Boarding (no skill) so the gap is honest.
    const employees = fake.table("employees") as unknown as Employee[];
    const empB = employees.find((e) => e.id === "emp-b")!;
    empB.skills = ["Gate"]; // no longer qualified for Boarding

    await fake.from("flights").update({ actual_departure: "10:30" }).eq("id", "flight-1");
    const result = await evaluateFlightDelayImpact(fake as unknown as SupabaseClient, "flight-1");
    if ("error" in result) throw new Error(result.error);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].replacementCandidates).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // Regression coverage for the 2026-10-04 fix: the delayed flight's new
  // window can run past the incumbent's own shift end with NO other
  // duty anywhere nearby to "collide" with -- that must still be
  // reported as a real conflict, not silently treated as still covered.
  // -------------------------------------------------------------------

  it("detects a shift-boundary violation even with no colliding other assignment, and recommends a replacement", async () => {
    const fake = new FakeSupabase();
    seedBaseFixture(fake);

    // emp-a's shift ends at 18:15 by default (makeEmployee) -- far later
    // than anything in this fixture, so no fixture-wide test would ever
    // hit a shift boundary by accident. Narrow it here, specifically for
    // this test, to just past flight-1's original 08:00-09:00 window.
    const employees = fake.table("employees") as unknown as Employee[];
    const empA = employees.find((e) => e.id === "emp-a")!;
    empA.shift_end = "09:30";

    // Delay flight-1 so its new window (09:30-10:30) ends after emp-a's
    // 09:30 shift end AND newly overlaps emp-a's existing flight-2 Gate
    // duty (10:00-11:00) -- deliberately left in, since a real delay
    // commonly triggers both reasons at once, and the conflict object
    // must carry both independently rather than only reporting
    // whichever was checked first.
    await fake.from("flights").update({ actual_departure: "10:30" }).eq("id", "flight-1");

    const result = await evaluateFlightDelayImpact(fake as unknown as SupabaseClient, "flight-1");
    if ("error" in result) throw new Error(result.error);

    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0];
    expect(conflict.employee.id).toBe("emp-a");
    expect(conflict.shiftBoundaryViolation).toEqual({ shiftStart: "08:00", shiftEnd: "09:30" });
    // Both reasons fire together here -- neither suppresses the other.
    expect(conflict.collidesWith?.requirement.id).toBe("req-2");
    expect(conflict.newWindow).toEqual({ start: "09:30", end: "10:30" });
    expect(conflict.replacementCandidates.some((c) => c.employee.id === "emp-b")).toBe(true);
  });

  it("reports ONLY the shift-boundary reason when there is no other duty to collide with", async () => {
    const fake = new FakeSupabase();
    seedBaseFixture(fake);

    // Remove emp-a's flight-2 assignment entirely so there is nothing
    // left for the new window to collide with -- isolates the
    // shift-boundary check from the collision check.
    const assignments = fake.table("assignments") as unknown as Assignment[];
    const withoutAssign2 = assignments.filter((a) => a.id !== "assign-2");
    assignments.length = 0;
    assignments.push(...withoutAssign2);

    const employees = fake.table("employees") as unknown as Employee[];
    const empA = employees.find((e) => e.id === "emp-a")!;
    empA.shift_end = "09:30";

    // New window becomes 09:00-10:00 -- past the 09:30 shift end, but
    // nowhere near flight-2's now-irrelevant (and now unassigned) window.
    await fake.from("flights").update({ actual_departure: "10:00" }).eq("id", "flight-1");

    const result = await evaluateFlightDelayImpact(fake as unknown as SupabaseClient, "flight-1");
    if ("error" in result) throw new Error(result.error);

    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0];
    expect(conflict.newWindow).toEqual({ start: "09:00", end: "10:00" });
    expect(conflict.shiftBoundaryViolation).toEqual({ shiftStart: "08:00", shiftEnd: "09:30" });
    expect(conflict.collidesWith).toBeUndefined();
  });

  it("does NOT report a shift-boundary violation that already existed before the delay (pre-existing, not newly caused)", async () => {
    const fake = new FakeSupabase();
    seedBaseFixture(fake);

    const assignments = fake.table("assignments") as unknown as Assignment[];
    const withoutAssign2 = assignments.filter((a) => a.id !== "assign-2");
    assignments.length = 0;
    assignments.push(...withoutAssign2);

    const employees = fake.table("employees") as unknown as Employee[];
    const empA = employees.find((e) => e.id === "emp-a")!;
    // Shift already ends BEFORE flight-1's original 08:00-09:00 window
    // even starts -- a pre-existing, already-invalid assignment this
    // flow isn't responsible for surfacing (same principle as a
    // pre-existing collision).
    empA.shift_start = "10:00";
    empA.shift_end = "18:00";

    // No operational change at all -- still, this must report zero
    // conflicts, since nothing NEW was caused by a delay that didn't
    // happen.
    const result = await evaluateFlightDelayImpact(fake as unknown as SupabaseClient, "flight-1");
    if ("error" in result) throw new Error(result.error);
    expect(result.conflicts).toHaveLength(0);
  });
});

describe("live-ops-service — confirmReassignment", () => {
  it("replaces the assignment, writes an assignment_modifications 'replaced' row and an audit_log_entries row, without touching the other assignment", async () => {
    const fake = new FakeSupabase();
    seedBaseFixture(fake);
    await fake.from("audit_log_entries").insert({ id: "audit-0", step_number: 0, description: "seed" });

    const result = await confirmReassignment(fake as unknown as SupabaseClient, {
      staffingRequirementId: "req-1",
      oldEmployeeId: "emp-a",
      newEmployeeId: "emp-b",
      reason: "AT301 delayed; emp-a now conflicted on Gate (AT302)",
    });

    expect(result.ok).toBe(true);

    const assignments = fake.table("assignments") as unknown as Assignment[];
    // Old row for (req-1, emp-a) is gone...
    expect(assignments.some((a) => a.staffing_requirement_id === "req-1" && a.employee_id === "emp-a")).toBe(false);
    // ...replaced by a new row for (req-1, emp-b)...
    const newRow = assignments.find((a) => a.staffing_requirement_id === "req-1" && a.employee_id === "emp-b");
    expect(newRow).toBeDefined();
    expect(newRow!.source).toBe("human_modified");
    // ...and the UNRELATED req-2/emp-a assignment is completely untouched.
    expect(assignments.some((a) => a.staffing_requirement_id === "req-2" && a.employee_id === "emp-a")).toBe(true);

    const mods = fake.table("assignment_modifications") as unknown as AssignmentModification[];
    expect(mods).toHaveLength(1);
    expect(mods[0]).toMatchObject({
      staffing_requirement_id: "req-1",
      action: "replaced",
      previous_employee_id: "emp-a",
      new_employee_id: "emp-b",
    });
    expect(mods[0].plan_id).toBe(PLAN_ID);

    const auditEntries = fake.table("audit_log_entries") as { step_number: number; description: string }[];
    const newest = [...auditEntries].sort((a, b) => b.step_number - a.step_number)[0];
    expect(newest.description).toContain("Operational reassignment");
    expect(newest.description).toContain("Employee A");
    expect(newest.description).toContain("Employee B");
    expect(newest.description).toContain("Confirmed by Mohammed Alaoui");
  });

  it("rejects a reassignment when the old employee doesn't actually hold that assignment", async () => {
    const fake = new FakeSupabase();
    seedBaseFixture(fake);

    const result = await confirmReassignment(fake as unknown as SupabaseClient, {
      staffingRequirementId: "req-1",
      oldEmployeeId: "emp-b", // emp-b was never assigned to req-1
      newEmployeeId: "emp-a",
      reason: "bogus",
    });

    expect(result.ok).toBe(false);
    const assignments = fake.table("assignments") as unknown as Assignment[];
    expect(assignments).toHaveLength(2); // nothing changed
  });
});
