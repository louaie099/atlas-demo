import { describe, it, expect } from "vitest";
import { generateDutiesForDay } from "../lib/planning/duty-generation";
import { generateDraftWeeklyPlan } from "../lib/planning/generate-draft-plan";
import { GeneratedShiftAssignment, ActualRestHoursByEmployeeDay } from "../lib/planning/shift-generation";
import { CONFIG } from "../lib/seed-data";
import { Employee, Flight, StaffingRequirement } from "../lib/types";

/**
 * Regression coverage for the "two definitions of rest" bug: Stage 9
 * (scoring.ts's scoreCandidates, via generateDutiesForDay) used to gate
 * duty eligibility on the employee's STATIC, persisted
 * rest_before_shift_hours field -- stale the moment demand-driven
 * generation puts someone on a different real shift than their old
 * baseline implied. Stage 6 (shift-generation.ts /
 * specialized-team-generation.ts) already computed real rest correctly.
 * The fix: enforceRestInvariantAcrossWeek now also returns
 * ActualRestHoursByEmployeeDay, the single authoritative source, which
 * generateDutiesForDay uses (via an optional parameter) instead of the
 * static field. These tests exercise generateDutiesForDay directly
 * (unit-level, proving the override itself) and generateDraftWeeklyPlan
 * (whole-pipeline, proving zero overlaps/OFF-day assignments/persisted
 * hard-rest violations survive the change).
 */

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "emp",
    name: "Test",
    skills: ["Boarding"],
    assignment: "General T1 Pool",
    shift_code: null,
    shift_start: null,
    shift_end: null,
    rest_before_shift_hours: null,
    weekly_hours: null,
    is_duty_officer: false,
    off_days: [],
    foreign_company_authorizations: [],
    active: true,
    weekly_shifts: [{ day_of_week: "Wednesday", shift_code: null, status: "working" }],
    ...overrides,
  };
}

function makeFlight(overrides: Partial<Flight>): Flight {
  return {
    id: "f1",
    flight_number: "AT100",
    airline: "Royal Air Maroc",
    route: "CMN → X",
    origin: "CMN",
    destination: "X",
    aircraft: "Boeing 737-800",
    equipment_code: null,
    registration: null,
    callsign: null,
    terminal: "T1",
    scheduled_departure: "10:00",
    scheduled_arrival: null,
    gate: null,
    boarding_window_start: "09:00",
    boarding_window_end: "10:00",
    status: "scheduled",
    booking_pressure: "normal",
    day_of_week: "Wednesday",
    operator_type: "atlas_managed",
    destination_category: "Europe/Schengen",
    booked_passengers: null,
    seat_capacity: null,
    ...overrides,
  };
}

function makeRequirement(overrides: Partial<StaffingRequirement>): StaffingRequirement {
  return {
    id: "r1",
    flight_id: "f1",
    role: "Boarding",
    baseline_requirement: 1,
    additional_requirement: 0,
    total_requirement: 1,
    source: "fixed_rule",
    reasoning: "",
    needs_configuration: false,
    ...overrides,
  };
}

describe("generateDutiesForDay — actual rest overrides the stale static field", () => {
  it("REGRESSION: an employee with a stale rest_before_shift_hours < 15 but actual generated rest >= 15 CAN receive a duty", () => {
    const flight = makeFlight({ scheduled_departure: "10:00" }); // Boarding window 09:00-10:00
    const requirement = makeRequirement({ total_requirement: 1 });
    const employee = makeEmployee({
      id: "e1",
      skills: ["Boarding"],
      rest_before_shift_hours: 10, // stale/static -- would have failed the OLD check
      weekly_hours: 20,
    });
    const generatedShifts: GeneratedShiftAssignment[] = [{ employeeId: "e1", dayOfWeek: "Wednesday", shiftCode: "NR01", coversRoles: ["Boarding"] }];
    const actualRest: ActualRestHoursByEmployeeDay = new Map([["e1|Wednesday", 15]]); // the REAL rest before this real shift

    const { duties, unfilled } = generateDutiesForDay("Wednesday", [requirement], [flight], [employee], generatedShifts, [], CONFIG, actualRest);
    expect(unfilled).toHaveLength(0);
    expect(duties).toHaveLength(1);
    expect(duties[0].employeeId).toBe("e1");
  });

  it("REGRESSION: an employee whose ACTUAL generated rest is < 15 remains ineligible, even if their stale static field says otherwise", () => {
    const flight = makeFlight({ scheduled_departure: "10:00" });
    const requirement = makeRequirement({ total_requirement: 1 });
    const employee = makeEmployee({
      id: "e1",
      skills: ["Boarding"],
      rest_before_shift_hours: 20, // stale/static -- would have PASSED the old check
      weekly_hours: 20,
    });
    const generatedShifts: GeneratedShiftAssignment[] = [{ employeeId: "e1", dayOfWeek: "Wednesday", shiftCode: "NR01", coversRoles: ["Boarding"] }];
    const actualRest: ActualRestHoursByEmployeeDay = new Map([["e1|Wednesday", 10]]); // the REAL rest is actually insufficient

    const { duties, unfilled } = generateDutiesForDay("Wednesday", [requirement], [flight], [employee], generatedShifts, [], CONFIG, actualRest);
    expect(duties).toHaveLength(0);
    expect(unfilled).toHaveLength(1);
    expect(unfilled[0].stillNeeded).toBe(1);
  });

  it("REGRESSION: Profiling/Mesure employees use the same actual-roster rest source, not their own stale static field either", () => {
    const flight = makeFlight({ scheduled_departure: "10:00" }); // fixed_rule Profiling, T-60 -> window 09:00-10:00
    const requirement = makeRequirement({ role: "Profiling", total_requirement: 1 });
    const employee = makeEmployee({
      id: "p1",
      assignment: "Profiling",
      skills: ["Profiling"],
      rest_before_shift_hours: 13.75, // exactly the kind of stale value seen on real Profiling/Mesure seed data
      weekly_hours: 20,
    });
    const generatedShifts: GeneratedShiftAssignment[] = [{ employeeId: "p1", dayOfWeek: "Wednesday", shiftCode: "NR01", coversRoles: ["Profiling"] }];
    const actualRest: ActualRestHoursByEmployeeDay = new Map([["p1|Wednesday", 15]]);

    const { duties, unfilled } = generateDutiesForDay("Wednesday", [requirement], [flight], [employee], generatedShifts, [], CONFIG, actualRest);
    expect(unfilled).toHaveLength(0);
    expect(duties).toHaveLength(1);
    expect(duties[0].employeeId).toBe("p1");
  });

  it("falls back to the static field when no actual-rest entry exists at all (backward compatible — every existing caller/test that never passes this parameter keeps working unchanged)", () => {
    const flight = makeFlight({ scheduled_departure: "10:00" });
    const requirement = makeRequirement({ total_requirement: 1 });
    const employee = makeEmployee({ id: "e1", skills: ["Boarding"], rest_before_shift_hours: 20, weekly_hours: 20 });
    const generatedShifts: GeneratedShiftAssignment[] = [{ employeeId: "e1", dayOfWeek: "Wednesday", shiftCode: "NR01", coversRoles: ["Boarding"] }];

    const { duties } = generateDutiesForDay("Wednesday", [requirement], [flight], [employee], generatedShifts, [], CONFIG);
    expect(duties).toHaveLength(1); // no actualRestHoursByDay argument at all -- static field (20h) still governs
  });
});

describe("generateDraftWeeklyPlan — whole-pipeline invariants hold after the actual-rest fix", () => {
  // A realistic small workforce: several employees carry a deliberately
  // LOW static rest_before_shift_hours (exactly the seed-data condition
  // that triggered the bug) so this test would have failed under the OLD
  // stale-field check and must pass now.
  const employees: Employee[] = [
    {
      id: "t1-1", name: "T1 One", skills: ["Boarding", "Check-in", "Gate"], assignment: "General T1 Pool",
      shift_code: null, shift_start: null, shift_end: null, rest_before_shift_hours: 10, weekly_hours: 0,
      is_duty_officer: false, off_days: [], foreign_company_authorizations: [], active: true,
      weekly_shifts: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((d) => ({ day_of_week: d, shift_code: null, status: "off" as const })),
    },
    {
      id: "t1-2", name: "T1 Two", skills: ["Boarding", "Check-in", "Gate"], assignment: "General T1 Pool",
      shift_code: null, shift_start: null, shift_end: null, rest_before_shift_hours: 11, weekly_hours: 0,
      is_duty_officer: false, off_days: [], foreign_company_authorizations: [], active: true,
      weekly_shifts: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((d) => ({ day_of_week: d, shift_code: null, status: "off" as const })),
    },
    {
      id: "p1", name: "Profiling One", skills: ["Profiling"], assignment: "Profiling",
      shift_code: null, shift_start: null, shift_end: null, rest_before_shift_hours: 13.75, weekly_hours: 0,
      is_duty_officer: false, off_days: [], foreign_company_authorizations: [], active: true,
      weekly_shifts: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((d) => ({ day_of_week: d, shift_code: null, status: "off" as const })),
    },
  ];

  const daysOrder = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const flights: Flight[] = daysOrder.map((day, i) => ({
    id: `f-${day}`, flight_number: `AT${100 + i}`, airline: "Royal Air Maroc", route: "CMN → X",
    origin: "CMN", destination: "X", aircraft: "Boeing 737-800", equipment_code: null, registration: null,
    callsign: null, terminal: "T1", scheduled_departure: "10:00", scheduled_arrival: null, gate: null,
    boarding_window_start: null, boarding_window_end: null, status: "scheduled", booking_pressure: "normal",
    day_of_week: day, operator_type: "atlas_managed", destination_category: "Europe/Schengen",
    booked_passengers: null, seat_capacity: null,
  }));
  const requirements: StaffingRequirement[] = flights.flatMap((f) => [
    { id: `r-boarding-${f.day_of_week}`, flight_id: f.id, role: "Boarding", baseline_requirement: 1, additional_requirement: 0, total_requirement: 1, source: "fixed_rule" as const, reasoning: "", needs_configuration: false },
    { id: `r-profiling-${f.day_of_week}`, flight_id: f.id, role: "Profiling", baseline_requirement: 1, additional_requirement: 0, total_requirement: 1, source: "fixed_rule" as const, reasoning: "", needs_configuration: false },
  ]);

  const plan = generateDraftWeeklyPlan(flights, employees, [], CONFIG, daysOrder, "Test Week");
  const allDuties = Object.entries(plan.dutiesByDay).flatMap(([dayOfWeek, duties]) => duties.map((d) => ({ ...d, dayOfWeek })));

  it("produces zero overlapping duties for any employee across the whole generated week", () => {
    function overlaps(a: { start: string; end: string }, b: { start: string; end: string }) {
      const t = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
      return t(a.start) < t(b.end) && t(b.start) < t(a.end);
    }
    const dutiesByEmployeeDay = new Map<string, { start: string; end: string }[]>();
    for (const duty of allDuties) {
      const key = `${duty.employeeId}|${duty.dayOfWeek}`;
      const list = dutiesByEmployeeDay.get(key) ?? [];
      list.push(duty.window);
      dutiesByEmployeeDay.set(key, list);
    }
    let overlapCount = 0;
    for (const windows of dutiesByEmployeeDay.values()) {
      for (let i = 0; i < windows.length; i++) {
        for (let j = i + 1; j < windows.length; j++) {
          if (overlaps(windows[i], windows[j])) overlapCount++;
        }
      }
    }
    expect(overlapCount).toBe(0);
  });

  it("never assigns a duty to an employee on a day their persisted roster entry says they are OFF", () => {
    const rosterByEmployeeDay = new Map(plan.rosterEntries.map((r) => [`${r.employee_id}|${r.day_of_week}`, r.status]));
    let violations = 0;
    for (const duty of allDuties) {
      const status = rosterByEmployeeDay.get(`${duty.employeeId}|${duty.dayOfWeek}`);
      if (status !== "working") violations++;
    }
    expect(violations).toBe(0);
    expect(allDuties.length).toBeGreaterThan(0); // sanity: the fix actually produced real duties, not zero
  });

  it("persists zero rest_violation issues (the confirmed 15h minimum stays hard through this change)", () => {
    const restViolations = plan.issues.filter((i) => i.type === "rest_violation");
    expect(restViolations).toHaveLength(0);
  });
});
