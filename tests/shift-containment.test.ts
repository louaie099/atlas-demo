import { describe, it, expect } from "vitest";
import { scoreCandidates, isWindowWithinShift } from "../lib/scoring";
import { generateDutiesForDay } from "../lib/planning/duty-generation";
import { getShiftTimesAs } from "../lib/shift-templates";
import { CONFIG } from "../lib/seed-data";
import { Employee, Flight, StaffingRequirement } from "../lib/types";

/**
 * PLANNING INTEGRITY — FULL SHIFT CONTAINMENT (2026-10-04 audit fix).
 *
 * The rule, as confirmed by the product owner: for AUTOMATIC planning,
 * task.start >= shift.start AND task.end <= shift.end is a HARD assignment
 * constraint. An employee whose shift only partially overlaps the duty
 * window must NEVER be silently auto-assigned — not even when the shift
 * reaches through departure, and not merely because a Duty Officer could
 * theoretically override it later. These tests pin that contract directly
 * against scoreCandidates (the single shared eligibility function every
 * real caller — duty generation, Find Agent / Live Ops replacement lookup,
 * the Assign API's re-validation, Check-in zone routes — goes through) and
 * end-to-end through generateDutiesForDay (the function that decides what
 * actually gets auto-assigned in a generated plan).
 *
 * Root cause this fixes: scoreCandidates used to only compare the shift's
 * END against the window's END ("extensionNeeded") — a shift starting
 * AFTER the window opened was never checked at all and sailed straight to
 * "recommended". That is exactly how two real, previously-unknown-to-be-
 * invalid assignments made it into a generated plan: Sanaa Benali (shift
 * MT03, 05:45–14:45) auto-assigned to AT2101's 05:30–06:30 Gate duty, and
 * Youssef El Amrani (shift JR01, 05:45–18:30) auto-assigned to AT2101's
 * 05:30–06:30 Profiling duty — both reproduced directly below. The audit
 * that found this checked a full real month of generated duties and found
 * 50 identical violations, all the same early-start shape, none late-end,
 * none off-day, none overlap, none qualification, none team-restriction —
 * confirming this was the one, systemic root cause.
 */

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "emp", name: "Test", skills: ["Boarding"], assignment: "General T1 Pool",
    shift_code: null, shift_start: "09:00", shift_end: "17:00", rest_before_shift_hours: 24,
    weekly_hours: 10, is_duty_officer: false, off_days: [], foreign_company_authorizations: [],
    active: true, weekly_shifts: [],
    ...overrides,
  };
}

function makeFlight(overrides: Partial<Flight>): Flight {
  return {
    id: "f1", flight_number: "AT100", airline: "Royal Air Maroc", route: "CMN → X",
    origin: "CMN", destination: "X", aircraft: "Boeing 737-800", equipment_code: null,
    registration: null, callsign: null, terminal: "T1", scheduled_departure: "10:00",
    scheduled_arrival: null, gate: null, boarding_window_start: null, boarding_window_end: null,
    status: "scheduled", booking_pressure: "normal", day_of_week: "Wednesday", flight_date: "2026-10-05", week_start: "2026-10-05",
    operator_type: "atlas_managed", destination_category: "Europe/Schengen",
    booked_passengers: null, seat_capacity: null,
    ...overrides,
  };
}

function makeRequirement(overrides: Partial<StaffingRequirement>): StaffingRequirement {
  return {
    id: "r1", flight_id: "f1", role: "Gate", baseline_requirement: 1, additional_requirement: 0,
    total_requirement: 1, source: "fixed_rule", reasoning: "", needs_configuration: false,
    ...overrides,
  };
}

const WINDOW = { start: "09:00", end: "10:00" };

describe("isWindowWithinShift — the single shared full-containment predicate (scoring.ts and live-ops-service.ts both use this)", () => {
  it("true when the window is fully inside the shift, including exact boundary equality", () => {
    expect(isWindowWithinShift(WINDOW, "09:00", "10:00")).toBe(true); // exact match
    expect(isWindowWithinShift(WINDOW, "08:30", "10:30")).toBe(true); // wider shift
  });
  it("false when the window starts before the shift", () => {
    expect(isWindowWithinShift(WINDOW, "09:15", "10:00")).toBe(false);
  });
  it("false when the window ends after the shift", () => {
    expect(isWindowWithinShift(WINDOW, "09:00", "09:45")).toBe(false);
  });
  it("true (no violation) when either shift boundary is missing, rather than guessing", () => {
    expect(isWindowWithinShift(WINDOW, null, "10:00")).toBe(true);
    expect(isWindowWithinShift(WINDOW, "09:00", null)).toBe(true);
  });
});

describe("scoreCandidates — full shift containment is a hard automatic-assignment gate", () => {
  it("task begins before shift start → REJECT (never 'recommended', even though the shift reaches through the window's end)", () => {
    const employee = makeEmployee({ id: "e1", skills: ["Gate"], shift_start: "09:15", shift_end: "10:00" }); // starts 15min after window opens
    const [result] = scoreCandidates("Gate", WINDOW, [employee], CONFIG);
    expect(result.status).toBe("flagged");
    expect(result.reasoning).toMatch(/early call-in/);
  });

  it("task ends after shift end → REJECT (the pre-existing extension check, unchanged)", () => {
    const employee = makeEmployee({ id: "e1", skills: ["Gate"], shift_start: "09:00", shift_end: "09:45" }); // ends 15min before window closes
    const [result] = scoreCandidates("Gate", WINDOW, [employee], CONFIG);
    expect(result.status).toBe("flagged");
    expect(result.reasoning).toMatch(/shift extension/);
  });

  it("task exactly matches the shift boundary → ALLOW (recommended)", () => {
    const employee = makeEmployee({ id: "e1", skills: ["Gate"], shift_start: "09:00", shift_end: "10:00" }); // identical to WINDOW
    const [result] = scoreCandidates("Gate", WINDOW, [employee], CONFIG);
    expect(result.status).toBe("recommended");
  });

  it("employee OFF (no roster/shift at all) → REJECT — never even enters the candidate pool", () => {
    const employee = makeEmployee({ id: "e1", shift_start: null, shift_end: null, rest_before_shift_hours: null, weekly_hours: null });
    const results = scoreCandidates("Gate", WINDOW, [employee], CONFIG);
    expect(results).toHaveLength(0);
  });

  it("overlapping incompatible duty already held → REJECT — excluded before scoring, regardless of shift containment", () => {
    const employee = makeEmployee({ id: "e1", shift_start: "08:00", shift_end: "11:00" }); // would otherwise fully contain WINDOW
    const occupied = { e1: [{ start: "08:30", end: "09:30" }] }; // overlaps WINDOW's 09:00-09:30
    const results = scoreCandidates("Gate", WINDOW, [employee], CONFIG, occupied);
    expect(results).toHaveLength(0);
  });

  it("missing required qualification (skill) → REJECT — never enters the candidate pool", () => {
    const employee = makeEmployee({ id: "e1", skills: ["Boarding"], shift_start: "08:00", shift_end: "11:00" }); // fully contains WINDOW, but not Gate-qualified
    const results = scoreCandidates("Gate", WINDOW, [employee], CONFIG);
    expect(results).toHaveLength(0);
  });

  it("missing required foreign-company authorization → REJECT — never enters the candidate pool", () => {
    const employee = makeEmployee({ id: "e1", skills: [], foreign_company_authorizations: ["Air France"], shift_start: "08:00", shift_end: "11:00" });
    const results = scoreCandidates("Company Team", WINDOW, [employee], CONFIG, {}, "Qatar Airways");
    expect(results).toHaveLength(0);
  });

  it("valid employee (qualified, rested, fully containing shift, no conflicts) → ALLOW", () => {
    const employee = makeEmployee({ id: "e1", skills: ["Gate"], shift_start: "08:00", shift_end: "11:00", rest_before_shift_hours: 24 });
    const [result] = scoreCandidates("Gate", WINDOW, [employee], CONFIG);
    expect(result.status).toBe("recommended");
    expect(result.employee.id).toBe("e1");
  });

  it("no eligible employee at all → empty result, never a fabricated candidate", () => {
    const results = scoreCandidates("Gate", WINDOW, [], CONFIG);
    expect(results).toEqual([]);
  });
});

describe("generateDutiesForDay — end to end: automatic generation never auto-assigns a partial-containment candidate, and reports an honest gap instead", () => {
  it("sanity check: a candidate whose real shift genuinely covers the window is still auto-assigned (the fix doesn't over-correct)", () => {
    const flight = makeFlight({ scheduled_departure: "10:00" }); // Gate window (T-60): 09:00-10:00
    const requirement = makeRequirement({});
    const employee = makeEmployee({ id: "e1", skills: ["Gate"] });
    // MT03 (GMT regime, 05:45-14:45) fully contains 09:00-10:00.
    const generatedShifts = [{ employeeId: "e1", dayOfWeek: "Wednesday", shiftCode: "MT03", coversRoles: ["Gate"] }];

    const { duties, unfilled } = generateDutiesForDay("Wednesday", [requirement], [flight], [employee], generatedShifts, [], CONFIG, flight.flight_date);
    expect(duties).toHaveLength(1);
    expect(unfilled).toHaveLength(0);
  });

  it("no eligible (fully-containing) candidate exists → the requirement is reported unfilled, never filled with an invalid assignment", () => {
    const flight = makeFlight({ scheduled_departure: "06:30" }); // Gate window (T-60): 05:30-06:30
    const requirement = makeRequirement({});
    // Only candidate's real shift (MT03, 05:45-14:45) starts AFTER the window opens -- exactly the Sanaa Benali shape.
    const employee = makeEmployee({ id: "e1", skills: ["Gate"] });
    const generatedShifts = [{ employeeId: "e1", dayOfWeek: "Wednesday", shiftCode: "MT03", coversRoles: ["Gate"] }];

    const { duties, unfilled } = generateDutiesForDay("Wednesday", [requirement], [flight], [employee], generatedShifts, [], CONFIG, flight.flight_date);
    expect(duties).toHaveLength(0); // never an invalid assignment
    expect(unfilled).toEqual([{ dayOfWeek: "Wednesday", requirementId: "r1", role: "Gate", stillNeeded: 1 }]); // honest, reported gap
  });
});

describe("Direct reproduction of the two reported planning-integrity cases (2026-10-04 audit)", () => {
  // Real shift catalog times, GMT regime (effective 2026-09-20 onward) --
  // exactly what the live app resolves for these employees' real shift
  // codes on a real October 2026 date.
  const DATE = "2026-10-05"; // a Monday in the GMT regime
  const mt03 = getShiftTimesAs("MT03", DATE);
  const jr01 = getShiftTimesAs("JR01", DATE);

  it("MT03 is confirmed 05:45-14:45 and JR01 is confirmed 05:45-18:30 in the GMT regime (sanity check these tests track real catalog values, not stale ones)", () => {
    expect(mt03).toEqual({ shift_start: "05:45", shift_end: "14:45" });
    expect(jr01).toEqual({ shift_start: "05:45", shift_end: "18:30" });
  });

  it("Sanaa Benali — AT2101 Gate 05:30-06:30 with shift MT03 (05:45-14:45): no longer automatically assigned", () => {
    const flight = makeFlight({ id: "at2101", flight_number: "AT2101", scheduled_departure: "06:30", flight_date: DATE, week_start: DATE, day_of_week: "Monday" });
    const requirement = makeRequirement({ id: "req-gate", flight_id: "at2101", role: "Gate" });
    const sanaa = makeEmployee({ id: "sanaa-benali-71", name: "Sanaa Benali", skills: ["Gate"], shift_start: mt03.shift_start, shift_end: mt03.shift_end });

    const [result] = scoreCandidates("Gate", { start: "05:30", end: "06:30" }, [sanaa], CONFIG);
    expect(result.status).toBe("flagged"); // not silently "recommended" any more
    expect(result.reasoning).toMatch(/early call-in/);

    const generatedShifts = [{ employeeId: "sanaa-benali-71", dayOfWeek: "Monday", shiftCode: "MT03", coversRoles: ["Gate"] }];
    const { duties, unfilled } = generateDutiesForDay("Monday", [requirement], [flight], [sanaa], generatedShifts, [], CONFIG, DATE);
    expect(duties).toHaveLength(0); // never auto-assigned
    expect(duties.some((d) => d.employeeId === "sanaa-benali-71")).toBe(false);
    expect(unfilled).toEqual([{ dayOfWeek: "Monday", requirementId: "req-gate", role: "Gate", stillNeeded: 1 }]);
  });

  it("Youssef El Amrani — AT2101 Profiling 05:30-06:30 with shift JR01 (05:45-18:30): no longer automatically assigned because of shift containment, NOT because of Profiling qualification (he is genuinely Profiling-skilled)", () => {
    const flight = makeFlight({ id: "at2101", flight_number: "AT2101", scheduled_departure: "06:30", flight_date: DATE, week_start: DATE, day_of_week: "Monday" });
    const requirement = makeRequirement({ id: "req-profiling", flight_id: "at2101", role: "Profiling", source: "fixed_rule" });
    // Mirrors the real seed-data record: skills include Profiling, assignment stays "General T1 Pool" (not a dedicated Profiling team) -- team/pool label is not what decides qualification.
    const youssef = makeEmployee({ id: "youssef-el-amrani", name: "Youssef El Amrani", skills: ["Boarding", "Profiling"], assignment: "General T1 Pool", shift_start: jr01.shift_start, shift_end: jr01.shift_end });

    // Qualification is confirmed fine on its own: scoring against a window his shift DOES fully contain succeeds.
    const [containedResult] = scoreCandidates("Profiling", { start: "06:00", end: "06:30" }, [youssef], CONFIG);
    expect(containedResult.status).toBe("recommended");
    expect(containedResult.reasoning).toMatch(/Profiling-qualified/);

    // But against the REAL AT2101 Profiling window (05:30-06:30, starting before his 05:45 shift), it's a containment failure specifically.
    const [result] = scoreCandidates("Profiling", { start: "05:30", end: "06:30" }, [youssef], CONFIG);
    expect(result.status).toBe("flagged");
    expect(result.reasoning).toMatch(/early call-in/);
    expect(result.reasoning).toMatch(/Profiling-qualified/); // still says he's qualified -- the flag is about timing, not skill

    const generatedShifts = [{ employeeId: "youssef-el-amrani", dayOfWeek: "Monday", shiftCode: "JR01", coversRoles: ["Profiling"] }];
    const { duties, unfilled } = generateDutiesForDay("Monday", [requirement], [flight], [youssef], generatedShifts, [], CONFIG, DATE);
    expect(duties).toHaveLength(0); // never auto-assigned
    expect(duties.some((d) => d.employeeId === "youssef-el-amrani")).toBe(false);
    expect(unfilled).toEqual([{ dayOfWeek: "Monday", requirementId: "req-profiling", role: "Profiling", stillNeeded: 1 }]);
  });
});
