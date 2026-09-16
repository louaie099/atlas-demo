import { describe, it, expect } from "vitest";
import { generateDutiesForDay, buildDayEffectivePoolFromRosterEntries } from "../lib/planning/duty-generation";
import { CONFIG } from "../lib/seed-data";
import { Employee, Flight, StaffingRequirement, Assignment, WeeklyPlanRosterEntry } from "../lib/types";

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "emp", name: "Test", skills: ["Boarding"], assignment: "General T1 Pool",
    // AP01's real derived rest (24h - 9h duration) is 15h, exactly at the
    // confirmed floor -- not the old 12h placeholder, which predated it.
    shift_code: "AP01", shift_start: "13:45", shift_end: "22:45", rest_before_shift_hours: 15,
    weekly_hours: 10, is_duty_officer: false, off_days: [], foreign_company_authorizations: [],
    active: true, weekly_shifts: [{ day_of_week: "Wednesday", shift_code: "AP01", status: "working" }],
    ...overrides,
  };
}

function makeFlight(overrides: Partial<Flight>): Flight {
  return {
    id: "f1", flight_number: "AT100", airline: "Royal Air Maroc", route: "CMN → X",
    origin: "CMN", destination: "X", aircraft: "Boeing 737-800", equipment_code: null,
    registration: null, callsign: null, terminal: "T1", scheduled_departure: "14:00",
    scheduled_arrival: null, gate: null, boarding_window_start: "13:50", boarding_window_end: "14:20",
    status: "scheduled", booking_pressure: "normal", day_of_week: "Wednesday",
    operator_type: "atlas_managed", destination_category: "Europe/Schengen",
    booked_passengers: null, seat_capacity: null,
    ...overrides,
  };
}

function makeRequirement(overrides: Partial<StaffingRequirement>): StaffingRequirement {
  return {
    id: "r1", flight_id: "f1", role: "Boarding", baseline_requirement: 1, additional_requirement: 0,
    total_requirement: 1, source: "fixed_rule", reasoning: "", needs_configuration: false,
    ...overrides,
  };
}

describe("generateDutiesForDay -- STAGE 6/STAGE 9 COHERENCE (AT870 structural regression)", () => {
  // The exact structural shape traced live: THREE simultaneous roles
  // (Check-in, Gate, Boarding) sharing one overlapping time window.
  // Check-in needs 4, Gate needs 2, Boarding needs 2 -- total 8 -- and
  // exactly 8 employees exist: 4 are multi-qualified for all three roles
  // (the scarce "shared pool" -- exactly enough to cover Gate+Boarding's
  // combined 4-person need and nothing more), and 4 are qualified for
  // Check-in ONLY (the "additional legal idle candidates" -- exactly
  // enough for Check-in's remaining need once the shared pool is
  // correctly reserved for Gate/Boarding). This is deliberately TIGHT --
  // zero slack -- so any shortfall proves a real coherence failure, not
  // a scenario padded with spare capacity.
  function buildScenario() {
    const checkinFlight = makeFlight({ id: "f-ci", scheduled_departure: "10:00" });
    const checkinReq = makeRequirement({ id: "r-ci", flight_id: "f-ci", role: "Check-in", source: "demand_forecast", total_requirement: 4 });
    // Gate/Boarding: fixed_rule, T-60 from a 10:00 departure -> 09:00-10:00,
    // which genuinely overlaps Check-in's 07:00-09:15 window (both windows
    // touch 09:00-09:15) -- one real overlapping cluster, not three
    // independent ones.
    const gateFlight = makeFlight({ id: "f-ga", scheduled_departure: "10:00" });
    const gateReq = makeRequirement({ id: "r-ga", flight_id: "f-ga", role: "Gate", total_requirement: 2 });
    const boardingFlight = makeFlight({ id: "f-bo", scheduled_departure: "10:00" });
    const boardingReq = makeRequirement({ id: "r-bo", flight_id: "f-bo", role: "Boarding", total_requirement: 2 });

    const flights = [checkinFlight, gateFlight, boardingFlight];
    const requirements = [checkinReq, gateReq, boardingReq];

    // MT02 (04:30-14:45) fully covers every window above for all 8.
    const multiQualified = ["m1", "m2", "m3", "m4"].map((id) =>
      makeEmployee({ id, skills: ["Check-in", "Gate", "Boarding"], rest_before_shift_hours: 24, weekly_hours: 0 })
    );
    const checkinOnly = ["c1", "c2", "c3", "c4"].map((id) =>
      makeEmployee({ id, skills: ["Check-in"], rest_before_shift_hours: 24, weekly_hours: 0 })
    );
    const employees = [...multiQualified, ...checkinOnly];
    const generatedShifts = employees.map((e) => ({ employeeId: e.id, dayOfWeek: "Wednesday", shiftCode: "MT02", coversRoles: [] }));

    return { flights, requirements, employees, generatedShifts };
  }

  it("Stage 6 finds enough distinct capacity (8 people for 8 simultaneous positions) and Stage 9 preserves ALL of it -- zero slack, zero shortfall", () => {
    const { flights, requirements, employees, generatedShifts } = buildScenario();
    const { duties, unfilled } = generateDutiesForDay("Wednesday", requirements, flights, employees, generatedShifts, [], CONFIG);

    expect(unfilled).toHaveLength(0);
    expect(duties).toHaveLength(8);
    expect(duties.filter((d) => d.role === "Check-in")).toHaveLength(4);
    expect(duties.filter((d) => d.role === "Gate")).toHaveLength(2);
    expect(duties.filter((d) => d.role === "Boarding")).toHaveLength(2);
  });

  it("the multi-qualified shared pool is used for Gate/Boarding (the scarcer roles), never leaving Check-in to steal from it and starve Gate/Boarding -- Check-in is filled entirely from the Check-in-only pool", () => {
    const { flights, requirements, employees, generatedShifts } = buildScenario();
    const { duties } = generateDutiesForDay("Wednesday", requirements, flights, employees, generatedShifts, [], CONFIG);

    const checkinAssignees = new Set(duties.filter((d) => d.role === "Check-in").map((d) => d.employeeId));
    const gateBoardingAssignees = new Set(duties.filter((d) => d.role === "Gate" || d.role === "Boarding").map((d) => d.employeeId));
    // No overlap between the two sets -- Gate/Boarding got the 4 shared
    // people, Check-in got the 4 dedicated ones. (The specific split
    // could in principle go the other way and still be correct -- what
    // actually matters is BOTH groups end up fully covered, asserted
    // above; this test additionally confirms the shared pool wasn't
    // fragmented across roles in a way that would have made total
    // coverage impossible.)
    for (const id of checkinAssignees) expect(gateBoardingAssignees.has(id)).toBe(false);
  });

  it("no employee satisfies two overlapping duties even under this tight, simultaneous scenario", () => {
    const { flights, requirements, employees, generatedShifts } = buildScenario();
    const { duties } = generateDutiesForDay("Wednesday", requirements, flights, employees, generatedShifts, [], CONFIG);

    const byEmployee = new Map<string, { start: string; end: string }[]>();
    for (const d of duties) byEmployee.set(d.employeeId, [...(byEmployee.get(d.employeeId) ?? []), d.window]);
    for (const windows of byEmployee.values()) {
      expect(windows).toHaveLength(1); // each of these 8 employees has exactly one duty here
    }
  });

  it("deterministic: identical inputs produce byte-identical duties, in the same order, across repeated runs", () => {
    const { flights, requirements, employees, generatedShifts } = buildScenario();
    const run1 = generateDutiesForDay("Wednesday", requirements, flights, employees, generatedShifts, [], CONFIG);
    const run2 = generateDutiesForDay("Wednesday", requirements, flights, employees, generatedShifts, [], CONFIG);
    expect(run2.duties).toEqual(run1.duties);
    expect(run2.unfilled).toEqual(run1.unfilled);
  });

  it("qualification stays hard: an employee with none of the three required skills is never assigned, even when the pool is otherwise exactly tight", () => {
    const { flights, requirements, employees, generatedShifts } = buildScenario();
    const unqualified = makeEmployee({ id: "u1", skills: ["Profiling"], rest_before_shift_hours: 24, weekly_hours: 0 });
    const withExtra = [...employees, unqualified];
    const shiftsWithExtra = [...generatedShifts, { employeeId: "u1", dayOfWeek: "Wednesday", shiftCode: "MT02", coversRoles: [] }];

    const { duties } = generateDutiesForDay("Wednesday", requirements, flights, withExtra, shiftsWithExtra, [], CONFIG);
    expect(duties.some((d) => d.employeeId === "u1")).toBe(false);
  });

  it("OFF stays hard: an employee with no generated shift for the day is never assigned, even if they'd otherwise be exactly the missing piece", () => {
    const { flights, requirements, employees, generatedShifts } = buildScenario();
    // Remove one Check-in-only employee's generated shift entirely -- they exist but are OFF today.
    const shiftsMinusOne = generatedShifts.filter((s) => s.employeeId !== "c4");

    const { duties, unfilled } = generateDutiesForDay("Wednesday", requirements, flights, employees, shiftsMinusOne, [], CONFIG);
    expect(duties.some((d) => d.employeeId === "c4")).toBe(false);
    // Honest shortfall -- never fabricated from someone who isn't rostered.
    expect(unfilled.find((u) => u.role === "Check-in")?.stillNeeded).toBe(1);
  });

  it("rest stays hard: a candidate who would otherwise be picked but fails actual rest is skipped, and coverage falls back to the next legal candidate or an honest gap", () => {
    const { flights, requirements, employees, generatedShifts } = buildScenario();
    // c1 is put below the 15h floor via the actual-rest source; the other
    // 3 checkin-only employees remain legal, so Check-in should still
    // fill 4... except only 3 dedicated + 0 spare multi-qualified remain
    // available (multi-qualified are needed for Gate/Boarding), so this
    // must surface as a genuine, honest 1-short gap -- never a
    // rest-violating assignment to c1.
    const actualRest = new Map([["c1|Wednesday", 10]]);
    const { duties, unfilled } = generateDutiesForDay("Wednesday", requirements, flights, employees, generatedShifts, [], CONFIG, actualRest);

    expect(duties.some((d) => d.employeeId === "c1")).toBe(false);
    expect(unfilled.find((u) => u.role === "Check-in")?.stillNeeded).toBe(1);
    expect(duties.filter((d) => d.role === "Gate")).toHaveLength(2);
    expect(duties.filter((d) => d.role === "Boarding")).toHaveLength(2);
  });
});

describe("generateDutiesForDay -- sequential reuse still works alongside the new clustering logic", () => {
  it("one multi-qualified employee still covers three NON-overlapping roles across the day in a single shift (unaffected by overlap-cluster grouping, since none of these windows overlap each other)", () => {
    const checkinFlight = makeFlight({ id: "ci", scheduled_departure: "07:45" });
    const checkinReq = makeRequirement({ id: "r-ci", flight_id: "ci", role: "Check-in", source: "demand_forecast", total_requirement: 1 });
    const gateFlight = makeFlight({ id: "ga", scheduled_departure: "08:30" });
    const gateReq = makeRequirement({ id: "r-ga", flight_id: "ga", role: "Gate", total_requirement: 1 });
    const boardingFlight = makeFlight({ id: "bo", scheduled_departure: "10:00" });
    const boardingReq = makeRequirement({ id: "r-bo", flight_id: "bo", role: "Boarding", total_requirement: 1 });

    const flights = [checkinFlight, gateFlight, boardingFlight];
    const requirements = [checkinReq, gateReq, boardingReq];
    const employee = makeEmployee({ id: "multi-1", skills: ["Check-in", "Gate", "Boarding"], rest_before_shift_hours: 24, weekly_hours: 0 });
    const generatedShifts = [{ employeeId: "multi-1", dayOfWeek: "Wednesday", shiftCode: "MT02", coversRoles: [] }];

    const { duties, unfilled } = generateDutiesForDay("Wednesday", requirements, flights, [employee], generatedShifts, [], CONFIG);
    expect(unfilled).toHaveLength(0);
    expect(duties).toHaveLength(3);
    expect(duties.every((d) => d.employeeId === "multi-1")).toBe(true);
    expect(new Set(duties.map((d) => d.role))).toEqual(new Set(["Check-in", "Gate", "Boarding"]));
  });
});

describe("generateDutiesForDay", () => {
  it("assigns a qualified, rostered employee to a duty", () => {
    const flight = makeFlight({});
    const requirement = makeRequirement({});
    const employee = makeEmployee({ id: "e1" });
    // Flexible-pool employees now resolve SOLELY from Stage 6's generated
    // shift for the day (see effectiveShiftForDay) -- their static
    // weekly_shifts baseline is durable fallback data only, so this
    // generatedShift entry is what actually makes "e1" a candidate.
    const generatedShift = [{ employeeId: "e1", dayOfWeek: "Wednesday", shiftCode: "AP01", coversRoles: ["Boarding"] }];

    const { duties, unfilled } = generateDutiesForDay("Wednesday", [requirement], [flight], [employee], generatedShift, [], CONFIG);
    expect(duties).toHaveLength(1);
    expect(duties[0].employeeId).toBe("e1");
    expect(unfilled).toHaveLength(0);
  });

  it("never double-books an employee across two overlapping duties the same day", () => {
    // T-1h windows: flightA (14:00 departure) -> 13:00-14:00, flightB
    // (14:30 departure) -> 13:30-14:30 — partial overlap, 13:30-14:00.
    const flightA = makeFlight({ id: "a", scheduled_departure: "14:00" });
    const flightB = makeFlight({ id: "b", scheduled_departure: "14:30" }); // overlaps A
    const reqA = makeRequirement({ id: "ra", flight_id: "a", total_requirement: 1 });
    const reqB = makeRequirement({ id: "rb", flight_id: "b", total_requirement: 1 });

    // Only one qualified, rostered employee exists.
    const employee = makeEmployee({ id: "only-one" });
    const generatedShift = [{ employeeId: "only-one", dayOfWeek: "Wednesday", shiftCode: "AP01", coversRoles: ["Boarding"] }];

    const { duties, unfilled } = generateDutiesForDay(
      "Wednesday",
      [reqA, reqB],
      [flightA, flightB],
      [employee],
      generatedShift,
      [],
      CONFIG
    );
    // Assigned to exactly one of the two (the earlier by departure time), the other is left unfilled
    expect(duties).toHaveLength(1);
    expect(unfilled).toHaveLength(1);
  });

  it("leaves a requirement unfilled (not fabricated) when no rostered employee is qualified", () => {
    const flight = makeFlight({});
    const requirement = makeRequirement({ role: "Boarding" });
    const unqualified = makeEmployee({ id: "e1", skills: ["Gate"] });

    const { duties, unfilled } = generateDutiesForDay("Wednesday", [requirement], [flight], [unqualified], [], [], CONFIG);
    expect(duties).toHaveLength(0);
    expect(unfilled).toEqual([{ dayOfWeek: "Wednesday", requirementId: "r1", role: "Boarding", stillNeeded: 1 }]);
  });

  it("never assigns an employee with no roster for that day at all", () => {
    const flight = makeFlight({});
    const requirement = makeRequirement({});
    const notRostered = makeEmployee({
      id: "e1",
      shift_code: null,
      shift_start: null,
      shift_end: null,
      weekly_shifts: [],
    });

    const { duties } = generateDutiesForDay("Wednesday", [requirement], [flight], [notRostered], [], [], CONFIG);
    expect(duties).toHaveLength(0);
  });

  it("accounts for already-existing real Assignment rows when deciding how many more are needed", () => {
    const flight = makeFlight({});
    const requirement = makeRequirement({ total_requirement: 2 });
    const alreadyAssigned: Assignment = { id: "a1", plan_id: "plan-test", staffing_requirement_id: "r1", employee_id: "existing-1", source: "atlas_generated", created_by: null, assigned_at: "" };
    const newCandidate = makeEmployee({ id: "e2" });
    const generatedShift = [{ employeeId: "e2", dayOfWeek: "Wednesday", shiftCode: "AP01", coversRoles: ["Boarding"] }];

    const { duties, unfilled } = generateDutiesForDay(
      "Wednesday",
      [requirement],
      [flight],
      [newCandidate],
      generatedShift,
      [alreadyAssigned],
      CONFIG
    );
    expect(duties).toHaveLength(1); // only 1 more needed, since 1 of 2 is already covered
    expect(unfilled).toHaveLength(0);
  });

  it("prioritizes a freshly GENERATED shift over a flexible-pool employee's stale static baseline — proving demand-driven generation actually takes effect, not silently bypassed", () => {
    // A Boarding/fixed_rule requirement's window is now T-1h from departure
    // (standard aircraft) — see requirement-window.ts — so drive it via
    // scheduled_departure. 21:00 departure -> 20:00-21:00 window, which is
    // OUTSIDE the employee's stale static baseline shift (MT01: 05:45-14:45)
    // entirely — only the freshly generated shift (AP02) covers it.
    const flight = makeFlight({ scheduled_departure: "21:00" });
    const requirement = makeRequirement({});
    // This employee's stale seed baseline (MT01: 05:45-14:45) does NOT
    // cover this window at all — only the freshly generated shift does.
    // If the fix didn't work, this employee would be excluded entirely.
    const employee = makeEmployee({
      id: "flex-1",
      shift_code: "AP01",
      shift_start: "13:45",
      shift_end: "22:45",
      weekly_shifts: [{ day_of_week: "Wednesday", shift_code: "MT01", status: "working" }],
    });
    const generatedShift = [
      { employeeId: "flex-1", dayOfWeek: "Wednesday", shiftCode: "AP02", coversRoles: ["Boarding"] }, // 13:45-23:15, covers the 20:00-21:00 window. Same-day (not overnight) — NT01/N8/AP03/AP04 are overnight and trip a separate, already-documented limitation (simple minute-diff math doesn't handle midnight-crossing shifts), which is not what this test is isolating.
    ];

    const { duties } = generateDutiesForDay("Wednesday", [requirement], [flight], [employee], generatedShift, [], CONFIG);
    expect(duties).toHaveLength(1);
    expect(duties[0].employeeId).toBe("flex-1");
  });
});

describe("buildDayEffectivePoolFromRosterEntries — the same day-off gate manual assignment (Find Agent / Assign API) must use, not just automatic generation", () => {
  it("excludes an employee whose persisted roster entry for this day is 'off' — a fixed labor-rule protection (e.g. max consecutive off days) manual assignment must never be able to override", () => {
    const offEmployee = makeEmployee({ id: "e1" });
    const rosterEntries: WeeklyPlanRosterEntry[] = [
      { id: "r1", plan_id: "plan-1", employee_id: "e1", day_of_week: "Wednesday", status: "off", shift_code: null },
    ];

    const pool = buildDayEffectivePoolFromRosterEntries([offEmployee], rosterEntries, "Wednesday");
    expect(pool).toHaveLength(0);
  });

  it("excludes an employee with no roster entry at all for this day (e.g. no plan generated yet)", () => {
    const employee = makeEmployee({ id: "e1" });
    const pool = buildDayEffectivePoolFromRosterEntries([employee], [], "Wednesday");
    expect(pool).toHaveLength(0);
  });

  it("includes a working employee, with shift_start/shift_end substituted from the PERSISTED roster's shift_code, not the employee's static baseline", () => {
    const employee = makeEmployee({ id: "e1", shift_code: "MT01", shift_start: "05:45", shift_end: "14:45" });
    const rosterEntries: WeeklyPlanRosterEntry[] = [
      { id: "r1", plan_id: "plan-1", employee_id: "e1", day_of_week: "Wednesday", status: "working", shift_code: "AP01" },
    ];

    const pool = buildDayEffectivePoolFromRosterEntries([employee], rosterEntries, "Wednesday");
    expect(pool).toHaveLength(1);
    // AP01's real window (13:45-22:45), not the static baseline MT01 (05:45-14:45)
    expect(pool[0].shift_start).toBe("13:45");
    expect(pool[0].shift_end).toBe("22:45");
  });
});
