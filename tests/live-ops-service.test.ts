import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CONFIG } from "../lib/seed-data";
import { planIdForWeek } from "../lib/planning/weekly-plan-service";
import { getCandidatesForRequirement } from "../lib/planning/candidate-lookup";
import { loadLiveOpsView, evaluateFlightDelayImpact, confirmReassignment } from "../lib/live-ops-service";
import { deriveFlightState } from "../lib/live-ops-flight-state";
import { acknowledgeAlert, activeAlerts, reconcileAlerts } from "../lib/live-ops-alerts";
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

describe("live-ops-service — loadLiveOpsView gap triage (2026-10-09)", () => {
  it("classifies an unfilled requirement as eligible when a real candidate exists (category 1)", async () => {
    const fake = new FakeSupabase();
    const { req2 } = seedBaseFixture(fake);
    // Add a second seat to req-2 (Gate) with nobody covering it -- emp-b
    // is free, Gate-qualified, and not rest/overlap-excluded: a genuine
    // category-1 gap.
    const reqs = fake.table("staffing_requirements") as unknown as StaffingRequirement[];
    reqs.find((r) => r.id === req2.id)!.total_requirement = 2;

    const view = await loadLiveOpsView(fake as unknown as SupabaseClient, WEEK_START);
    const flight2View = view.flights.find((f) => f.flight.id === "flight-2")!;
    const req2View = flight2View.requirements.find((r) => r.requirement.id === "req-2")!;

    expect(req2View.gap).toBe(1);
    expect(req2View.gapResolution?.eligible).toBe(true);
    if (req2View.gapResolution?.eligible !== true) throw new Error("unreachable");
    expect(req2View.gapResolution.candidates.some((c) => c.employee.id === "emp-b" && c.status === "recommended")).toBe(true);
  });

  it("classifies an unfilled requirement as having no eligible employee, with the exclusion breakdown attached (category 2)", async () => {
    const fake = new FakeSupabase();
    const { req2 } = seedBaseFixture(fake);
    const reqs = fake.table("staffing_requirements") as unknown as StaffingRequirement[];
    reqs.find((r) => r.id === req2.id)!.total_requirement = 2;
    // Remove emp-b's Gate qualification -- now nobody at all can cover
    // the second seat.
    const employees = fake.table("employees") as unknown as Employee[];
    const empB = employees.find((e) => e.id === "emp-b")!;
    empB.skills = ["Boarding"];

    const view = await loadLiveOpsView(fake as unknown as SupabaseClient, WEEK_START);
    const flight2View = view.flights.find((f) => f.flight.id === "flight-2")!;
    const req2View = flight2View.requirements.find((r) => r.requirement.id === "req-2")!;

    expect(req2View.gap).toBe(1);
    expect(req2View.gapResolution?.eligible).toBe(false);
    if (req2View.gapResolution?.eligible !== false) throw new Error("unreachable");
    expect(req2View.gapResolution.exclusionSummary.length).toBeGreaterThan(0);
  });

  it("flags a currently-assigned employee's duty as invalidated once the flight's real departure moves it into collision with their own other duty (category 3), and (2026-10-09 fix) correctly drops effective coverage instead of still reading covered", async () => {
    const fake = new FakeSupabase();
    seedBaseFixture(fake);
    // Same operational delay as the evaluateFlightDelayImpact collision
    // test above: flight-1 09:00 -> 10:30 now collides with flight-2's
    // 10:00-11:00 Gate window, both held by emp-a.
    await fake.from("flights").update({ actual_departure: "10:30" }).eq("id", "flight-1");

    const view = await loadLiveOpsView(fake as unknown as SupabaseClient, WEEK_START);
    const flight1View = view.flights.find((f) => f.flight.id === "flight-1")!;
    const req1View = flight1View.requirements.find((r) => r.requirement.id === "req-1")!;

    // Fixed 2026-10-09: this used to read gap:0/"covered" here (see this
    // test's own prior assertions) purely because the stale Assignment
    // row still existed -- that was exactly the bug. emp-a's duty is
    // invalidated, so it no longer counts toward coverage: req-1 (total
    // requirement 1) now has an EFFECTIVE gap of 1, and the status is the
    // more specific "conflict" (an operational event broke a previously
    // valid assignment), not a plain "gap". The Assignment row itself is
    // untouched -- emp-a still appears in assignedEmployees, preserved as
    // planned history.
    expect(req1View.gap).toBe(1);
    expect(req1View.coverageStatus).toBe("conflict");
    expect(req1View.assignedEmployees.map((e) => e.id)).toEqual(["emp-a"]);
    expect(req1View.invalidatedAssignments).toHaveLength(1);
    const invalidated = req1View.invalidatedAssignments[0];
    expect(invalidated.employee.id).toBe("emp-a");
    expect(invalidated.oldWindow).toEqual({ start: "08:00", end: "09:00" });
    expect(invalidated.newWindow).toEqual({ start: "09:30", end: "10:30" });
    expect(invalidated.collidesWith?.requirement.id).toBe("req-2");
    expect(invalidated.shiftBoundaryViolation).toBeUndefined();

    // The newly-real gap must also come with real replacement candidates
    // -- emp-b is free, Gate/Boarding-qualified, not otherwise committed.
    expect(req1View.gapResolution?.eligible).toBe(true);
    if (req1View.gapResolution?.eligible !== true) throw new Error("unreachable");
    expect(req1View.gapResolution.candidates.some((c) => c.employee.id === "emp-b")).toBe(true);
  });

  it("does not flag an invalidated assignment that was already colliding before the delay (pre-existing, not newly caused), and leaves effective coverage exactly as raw headcount would read (no invalid assignments)", async () => {
    const fake = new FakeSupabase();
    seedBaseFixture(fake);
    // No operational change at all -- nothing should ever be flagged, and
    // the invalidation fix must be a complete no-op here: both
    // requirements are genuinely, validly covered by raw headcount alone.
    const view = await loadLiveOpsView(fake as unknown as SupabaseClient, WEEK_START);
    for (const f of view.flights) {
      for (const r of f.requirements) {
        expect(r.invalidatedAssignments).toHaveLength(0);
        expect(r.gap).toBe(0);
        expect(r.coverageStatus).toBe("assigned");
      }
    }
  });
});

describe("live-ops-service — invalidated-assignment effective coverage (2026-10-09 fix)", () => {
  it("counts only the invalidated employee against the requirement when one of two assigned employees on a Dreamliner becomes invalid", async () => {
    const fake = new FakeSupabase();
    seedBaseFixture(fake);

    // Turn req-2/flight-2 into a 2-seat Dreamliner Gate requirement held
    // by both emp-a and emp-b. Dreamliner lead is 90 min, so at its
    // original 11:00 departure the window is 09:30-11:00.
    await fake.from("flights").update({ aircraft: "Boeing 787-9" }).eq("id", "flight-2");
    const reqs = fake.table("staffing_requirements") as unknown as StaffingRequirement[];
    reqs.find((r) => r.id === "req-2")!.total_requirement = 2;
    await fake.from("assignments").insert({
      id: "assign-2b",
      plan_id: PLAN_ID,
      staffing_requirement_id: "req-2",
      employee_id: "emp-b",
      source: "human_modified",
      created_by: "Test Setup",
      assigned_at: new Date().toISOString(),
    });
    // Narrow only emp-a's shift so the delay pushes their window past
    // their own shift end -- emp-b's default (08:00-18:15) shift still
    // comfortably covers the new window, so only emp-a should invalidate.
    const employees = fake.table("employees") as unknown as Employee[];
    employees.find((e) => e.id === "emp-a")!.shift_end = "11:30";
    await fake.from("flights").update({ actual_departure: "12:30" }).eq("id", "flight-2");

    const view = await loadLiveOpsView(fake as unknown as SupabaseClient, WEEK_START);
    const flight2View = view.flights.find((f) => f.flight.id === "flight-2")!;
    const req2View = flight2View.requirements.find((r) => r.requirement.id === "req-2")!;

    expect(req2View.invalidatedAssignments.map((ia) => ia.employee.id)).toEqual(["emp-a"]);
    // 2 required, 1 (emp-b) still effectively valid -> effective gap of 1.
    expect(req2View.gap).toBe(1);
    expect(req2View.coverageStatus).toBe("conflict");
    // Both Assignment rows are untouched -- nothing deleted or modified.
    expect(req2View.assignedEmployees.map((e) => e.id).sort()).toEqual(["emp-a", "emp-b"]);
  });

  it("counts an effective gap equal to the full requirement when ALL currently-assigned employees are invalidated", async () => {
    const fake = new FakeSupabase();
    seedBaseFixture(fake);

    await fake.from("flights").update({ aircraft: "Boeing 787-9" }).eq("id", "flight-2");
    const reqs = fake.table("staffing_requirements") as unknown as StaffingRequirement[];
    reqs.find((r) => r.id === "req-2")!.total_requirement = 2;
    await fake.from("assignments").insert({
      id: "assign-2b",
      plan_id: PLAN_ID,
      staffing_requirement_id: "req-2",
      employee_id: "emp-b",
      source: "human_modified",
      created_by: "Test Setup",
      assigned_at: new Date().toISOString(),
    });
    // This time BOTH employees' shifts are too narrow for the delayed window.
    const employees = fake.table("employees") as unknown as Employee[];
    employees.find((e) => e.id === "emp-a")!.shift_end = "11:30";
    employees.find((e) => e.id === "emp-b")!.shift_end = "11:00";
    await fake.from("flights").update({ actual_departure: "12:30" }).eq("id", "flight-2");

    const view = await loadLiveOpsView(fake as unknown as SupabaseClient, WEEK_START);
    const flight2View = view.flights.find((f) => f.flight.id === "flight-2")!;
    const req2View = flight2View.requirements.find((r) => r.requirement.id === "req-2")!;

    expect(req2View.invalidatedAssignments.map((ia) => ia.employee.id).sort()).toEqual(["emp-a", "emp-b"]);
    expect(req2View.gap).toBe(2);
    expect(req2View.coverageStatus).toBe("conflict");
  });

  // ---- AT815 acceptance scenario -------------------------------------------
  // Mirrors the agreed end-to-end scenario exactly (a Dreamliner Gate
  // requirement, one assigned agent whose shift ends before the delayed
  // window, departure pushed from 13:45 to 18:45) using the existing,
  // generic data model and mechanisms only -- nothing here is a special
  // case keyed on a flight number or employee name in any production code
  // path; this is purely test fixture data shaped like the real scenario.
  function seedAT815Fixture(fake: FakeSupabase) {
    const marouane = makeEmployee({ id: "emp-marouane", name: "Marouane Benali", skills: ["Gate", "Boarding"], shift_start: "06:15", shift_end: "14:45" });
    // AP02 (13:45-23:15) comfortably covers the delayed 17:15-18:45
    // window -- unlike NR02 (08:00-18:15), used elsewhere in this file,
    // which would fall just short of its 18:45 end. The candidate pool
    // Find Agent scores against derives shift times from the roster
    // entry's shift_code (see buildDayEffectivePoolFromRosterEntries), so
    // these raw fields and the roster shift_code below must agree.
    const replacement = makeEmployee({ id: "emp-replacement", name: "Replacement Agent", skills: ["Gate", "Boarding"], shift_start: "13:45", shift_end: "23:15" });
    const flight = makeFlight({
      id: "flight-at815",
      flight_number: "AT815",
      aircraft: "Boeing 787-9",
      scheduled_departure: "13:45",
      day_of_week: "Monday",
      flight_date: WEEK_START,
    });
    const req = makeRequirement({ id: "req-at815-gate", flight_id: "flight-at815", role: "Gate", total_requirement: 1 });
    const assignment: Assignment = {
      id: "assign-at815",
      plan_id: PLAN_ID,
      staffing_requirement_id: "req-at815-gate",
      employee_id: "emp-marouane",
      source: "human_modified",
      created_by: "Test Setup",
      assigned_at: new Date().toISOString(),
    };
    const rosterMarouane: WeeklyPlanRosterEntry = { id: "roster-marouane", plan_id: PLAN_ID, employee_id: "emp-marouane", day_of_week: "Monday", status: "working", shift_code: "MT03" };
    const rosterReplacement: WeeklyPlanRosterEntry = { id: "roster-replacement", plan_id: PLAN_ID, employee_id: "emp-replacement", day_of_week: "Monday", status: "working", shift_code: "AP02" };
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

    fake.from("employees").insert([marouane, replacement] as unknown as FakeRow[]);
    fake.from("flights").insert([flight] as unknown as FakeRow[]);
    fake.from("staffing_requirements").insert([req] as unknown as FakeRow[]);
    fake.from("assignments").insert([assignment] as unknown as FakeRow[]);
    fake.from("weekly_plans").insert([plan] as unknown as FakeRow[]);
    fake.from("weekly_plan_roster_entries").insert([rosterMarouane, rosterReplacement] as unknown as FakeRow[]);

    return { flight, req, marouane, replacement };
  }

  it("AT815: departure 13:45 -> 18:45 recalculates the Dreamliner Gate window to 17:15-18:45, invalidates the MT03 agent (shift ends 14:45), and surfaces an eligible replacement", async () => {
    const fake = new FakeSupabase();
    seedAT815Fixture(fake);
    await fake.from("flights").update({ actual_departure: "18:45" }).eq("id", "flight-at815");

    const view = await loadLiveOpsView(fake as unknown as SupabaseClient, WEEK_START);
    const flightView = view.flights.find((f) => f.flight.id === "flight-at815")!;
    const reqView = flightView.requirements.find((r) => r.requirement.id === "req-at815-gate")!;

    expect(flightView.effectiveDeparture).toBe("18:45");
    expect(reqView.invalidatedAssignments).toHaveLength(1);
    const invalidated = reqView.invalidatedAssignments[0];
    expect(invalidated.employee.id).toBe("emp-marouane");
    expect(invalidated.oldWindow).toEqual({ start: "12:15", end: "13:45" });
    expect(invalidated.newWindow).toEqual({ start: "17:15", end: "18:45" });
    expect(invalidated.shiftBoundaryViolation).toEqual({ shiftStart: "06:15", shiftEnd: "14:45" });

    // Original planned assignment preserved as-is -- never deleted/modified.
    expect(reqView.assignedEmployees.map((e) => e.id)).toEqual(["emp-marouane"]);
    // Gate coverage decreases accordingly: 1 required, 0 effectively valid.
    expect(reqView.gap).toBe(1);
    expect(reqView.coverageStatus).toBe("conflict");
    // Find Agent evaluates the NEW window and finds the eligible replacement.
    expect(reqView.gapResolution?.eligible).toBe(true);
    if (reqView.gapResolution?.eligible !== true) throw new Error("unreachable");
    expect(reqView.gapResolution.candidates.some((c) => c.employee.id === "emp-replacement" && c.status === "recommended")).toBe(true);
  });

  it("AT815: the flight-level board state is 'gap' (Needs Action), never 'delayed' (At Risk) -- end-to-end through deriveFlightState against the REAL loadLiveOpsView output, not a hand-built fixture (2026-10-09, regression for the reported 'still shows At Risk' bug)", async () => {
    const fake = new FakeSupabase();
    seedAT815Fixture(fake);
    await fake.from("flights").update({ actual_departure: "18:45" }).eq("id", "flight-at815");

    const view = await loadLiveOpsView(fake as unknown as SupabaseClient, WEEK_START);
    const flightView = view.flights.find((f) => f.flight.id === "flight-at815")!;

    // The flight IS delayed (effectiveDeparture !== scheduled_departure) --
    // if coverageStatus/gap weren't wired into board state, this would
    // read "delayed" ("At Risk" in the header/filter), exactly the bug
    // reported. The invalidated assignment must take priority.
    expect(flightView.effectiveDeparture).not.toBe(flightView.flight.scheduled_departure);
    expect(deriveFlightState(flightView, false)).toBe("gap");
    expect(deriveFlightState(flightView, false)).not.toBe("delayed");

    // Same check the header's "At Risk" / "Needs Action" counters actually
    // run (see components/live-ops-header.tsx's countFor and
    // app/operations/page.tsx's filter predicate): this flight must count
    // toward needsAction ("gap"/"conflict"), never atRisk ("delayed").
    const state = deriveFlightState(flightView, false);
    const countsAsAtRisk = state === "delayed";
    const countsAsNeedsAction = state === "gap" || state === "conflict";
    expect(countsAsAtRisk).toBe(false);
    expect(countsAsNeedsAction).toBe(true);
  });

  it("AT815: operational coverage recovers and the issue resolves once the regulator confirms the eligible replacement", async () => {
    const fake = new FakeSupabase();
    seedAT815Fixture(fake);
    await fake.from("flights").update({ actual_departure: "18:45" }).eq("id", "flight-at815");

    const result = await confirmReassignment(fake as unknown as SupabaseClient, {
      staffingRequirementId: "req-at815-gate",
      oldEmployeeId: "emp-marouane",
      newEmployeeId: "emp-replacement",
      reason: "AT815 delayed to 18:45 -- original agent's MT03 shift ends 14:45.",
    });
    expect(result.ok).toBe(true);

    const view = await loadLiveOpsView(fake as unknown as SupabaseClient, WEEK_START);
    const flightView = view.flights.find((f) => f.flight.id === "flight-at815")!;
    const reqView = flightView.requirements.find((r) => r.requirement.id === "req-at815-gate")!;

    // Operational coverage updates and the issue resolves.
    expect(reqView.assignedEmployees.map((e) => e.id)).toEqual(["emp-replacement"]);
    expect(reqView.invalidatedAssignments).toHaveLength(0);
    expect(reqView.gap).toBe(0);
    expect(reqView.coverageStatus).toBe("assigned");
    // The change is traceable.
    expect(reqView.modification?.previousEmployeeName).toBe("Marouane Benali");
    expect(reqView.modification?.newEmployeeName).toBe("Replacement Agent");
  });

  it("AT815: the full Proactive Notifications acceptance scenario -- detected, consolidated, acknowledged, then auto-resolved on confirmed replacement -- end-to-end through the REAL loadLiveOpsView, with no evaluate-impact/drawer call anywhere in this test (2026-10-09, Live Operations phase 2)", async () => {
    const fake = new FakeSupabase();
    seedAT815Fixture(fake);

    // 1. The regulator delays AT815 from 13:45 to 18:45 -- an ordinary
    // operational PATCH, exactly what app/api/flights/[id]/operational
    // does. Nothing here calls evaluate-impact or opens any drawer.
    await fake.from("flights").update({ actual_departure: "18:45" }).eq("id", "flight-at815");

    // 2. ATLAS detects the invalidated assignment and updates effective
    // coverage purely from an ordinary GET /api/live-ops-equivalent read.
    const viewAfterDelay = await loadLiveOpsView(fake as unknown as SupabaseClient, WEEK_START);
    const alertsAfterDelay = reconcileAlerts([], viewAfterDelay.flights, null);
    const at815Alert = alertsAfterDelay.find((a) => a.flightId === "flight-at815");
    expect(at815Alert).toBeDefined();
    expect(at815Alert!.state).toBe("new");
    expect(at815Alert!.kind).toBe("invalidation");
    expect(at815Alert!.requirementIds).toContain("req-at815-gate");

    // 3. A second, unrelated refresh (e.g. the regulator just switching
    // tabs) must not mint a second alert for the same flight.
    const alertsAfterSecondRefresh = reconcileAlerts(alertsAfterDelay, viewAfterDelay.flights, null);
    expect(alertsAfterSecondRefresh.filter((a) => a.flightId === "flight-at815")).toHaveLength(1);
    expect(alertsAfterSecondRefresh.find((a) => a.flightId === "flight-at815")!.id).toBe(at815Alert!.id);

    // 4. The regulator acknowledges the alert -- this must not resolve it.
    const acknowledged = acknowledgeAlert(alertsAfterSecondRefresh, at815Alert!.id);
    expect(acknowledged.find((a) => a.flightId === "flight-at815")!.state).toBe("acknowledged");

    // 5. The regulator confirms an eligible replacement through the exact
    // same confirmReassignment path Find Agent already uses.
    const reassignResult = await confirmReassignment(fake as unknown as SupabaseClient, {
      staffingRequirementId: "req-at815-gate",
      oldEmployeeId: "emp-marouane",
      newEmployeeId: "emp-replacement",
      reason: "AT815 delayed to 18:45 -- original agent's MT03 shift ends 14:45.",
    });
    expect(reassignResult.ok).toBe(true);

    // 6. Once valid staffing coverage is restored, ATLAS automatically
    // marks the alert Resolved on the very next ordinary refresh -- no
    // manual "resolve" action, and the acknowledged state is correctly
    // superseded by resolution, not the other way around.
    const viewAfterReplacement = await loadLiveOpsView(fake as unknown as SupabaseClient, WEEK_START);
    const alertsAfterReplacement = reconcileAlerts(acknowledged, viewAfterReplacement.flights, null);
    const resolvedAlert = alertsAfterReplacement.find((a) => a.flightId === "flight-at815");
    expect(resolvedAlert).toBeDefined();
    expect(resolvedAlert!.state).toBe("resolved");
    expect(resolvedAlert!.id).toBe(at815Alert!.id);
    expect(activeAlerts(alertsAfterReplacement).some((a) => a.flightId === "flight-at815")).toBe(false);
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

describe("candidate-lookup — scores replacement candidates against the REAL (effective) departure, not a stale scheduled time (2026-10-04 fix)", () => {
  it("excludes a candidate whose roster shift fit the flight's ORIGINAL window but doesn't reach anywhere near its real, delayed window", async () => {
    const fake = new FakeSupabase();
    // emp-b's effective candidate-pool shift comes from its roster entry's
    // shift_code (NR02, 08:00-18:15 for this fixture's pre-regime-change
    // week) -- buildDayEffectivePoolFromRosterEntries overrides whatever
    // raw Employee.shift_start/shift_end say, so the window has to be
    // pushed outside THAT real catalog shift, not an arbitrary raw field.
    seedBaseFixture(fake);

    // Real departure moves to 20:00 -> the real window becomes 19:00-20:00,
    // entirely outside emp-b's 08:00-18:15 roster shift. getRequirementWindow
    // deliberately never reads actual_departure itself (every caller must
    // substitute it in) -- this function previously never did, so it
    // scored emp-b against the stale, ORIGINAL 08:00-09:00 window (which
    // sits comfortably inside their shift) and returned them as a clean
    // "recommended, no extension required" candidate for a flight that
    // will really be staffed at 19:00-20:00, hours after they're off.
    await fake.from("flights").update({ actual_departure: "20:00" }).eq("id", "flight-1");

    const result = await getCandidatesForRequirement(fake as unknown as SupabaseClient, "req-1", { excludeEmployeeIds: ["emp-a"] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    // emp-b's shift (08:00-18:15) has ZERO overlap with the REAL window
    // (19:00-20:00) -- must be excluded outright, not even flagged.
    expect(result.candidates.some((c) => c.employee.id === "emp-b")).toBe(false);
  });
});

describe("live-ops-service — evaluateFlightDelayImpact detects a collision even when the OTHER flight was also independently delayed (2026-10-04 fix)", () => {
  it("detects a NEW collision caused by two independent delays, using each flight's OWN live departure on both sides", async () => {
    const fake = new FakeSupabase();
    seedBaseFixture(fake);

    // flight-1 (Boarding, 08:00-09:00) and flight-2 (Gate, 10:00-11:00)
    // never overlap at their original times. Delay BOTH: flight-1 forward
    // to 10:30 (new window 09:30-10:30) and flight-2 earlier to 09:45 (new
    // window 08:45-09:45) -- together these now genuinely overlap
    // (09:30-09:45), purely as a product of two independent operational
    // changes, neither of which alone would have caused it.
    await fake.from("flights").update({ actual_departure: "10:30" }).eq("id", "flight-1");
    await fake.from("flights").update({ actual_departure: "09:45" }).eq("id", "flight-2");

    const result = await evaluateFlightDelayImpact(fake as unknown as SupabaseClient, "flight-1");
    if ("error" in result) throw new Error(result.error);

    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0];
    expect(conflict.employee.id).toBe("emp-a");
    expect(conflict.newWindow).toEqual({ start: "09:30", end: "10:30" });
    // The collision partner's reported window must reflect flight-2's OWN
    // live delay (08:45-09:45) -- previously this was built from
    // flight-2's stale, never-updated scheduled window (10:00-11:00),
    // which didn't even overlap flight-1's new window, silently missing
    // this collision entirely.
    expect(conflict.collidesWith?.window).toEqual({ start: "08:45", end: "09:45" });
    expect(conflict.replacementCandidates.some((c) => c.employee.id === "emp-b")).toBe(true);
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
