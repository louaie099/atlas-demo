import { describe, it, expect } from "vitest";
import { generateFlexiblePoolShifts } from "../lib/planning/shift-generation";
import { generateDutiesForDay } from "../lib/planning/duty-generation";
import { aggregateDailyDemand } from "../lib/planning/demand-aggregation";
import { CONFIG } from "../lib/seed-data";
import { Employee, Flight, StaffingRequirement } from "../lib/types";

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "emp", name: "Test", skills: ["Boarding"], assignment: "General T1 Pool",
    shift_code: null, shift_start: null, shift_end: null, rest_before_shift_hours: null,
    weekly_hours: null, is_duty_officer: false, off_days: [], foreign_company_authorizations: [],
    active: true, weekly_shifts: [{ day_of_week: "Wednesday", shift_code: null, status: "working" }],
    ...overrides,
  };
}

function makeFlight(overrides: Partial<Flight>): Flight {
  return {
    id: "f1", flight_number: "AT100", airline: "Royal Air Maroc", route: "CMN → X",
    origin: "CMN", destination: "X", aircraft: "Boeing 737-800", equipment_code: null,
    registration: null, callsign: null, terminal: "T1", scheduled_departure: "10:00",
    scheduled_arrival: null, gate: null, boarding_window_start: "09:00", boarding_window_end: "10:00",
    status: "scheduled", booking_pressure: "normal", day_of_week: "Wednesday", flight_date: "2026-09-03", week_start: "2026-09-01",
    operator_type: "atlas_managed", destination_category: "Europe/Schengen",
    booked_passengers: null, seat_capacity: null,
    ...overrides,
  };
}

function makeRequirement(overrides: Partial<StaffingRequirement>): StaffingRequirement {
  return {
    id: "r1", flight_id: "f1", role: "Boarding", baseline_requirement: 2, additional_requirement: 0,
    total_requirement: 2, source: "fixed_rule", reasoning: "", needs_configuration: false,
    ...overrides,
  };
}

// Matches makeFlight's default flight_date, well before the
// 2026-09-20 GMT+1 -> GMT regime change -- these unit tests exercise
// per-day rest/eligibility/coverage logic, not the regime resolver
// itself (see tests/shift-regime.test.ts for that).
const TEST_DATE = "2026-09-03";

describe("generateFlexiblePoolShifts", () => {
  it("assigns exactly enough qualified employees to meet peak demand", () => {
    const flight = makeFlight({});
    const requirement = makeRequirement({ total_requirement: 2 });
    const demand = aggregateDailyDemand("Wednesday", [flight], [requirement]);

    const employees = [
      makeEmployee({ id: "e1", skills: ["Boarding"] }),
      makeEmployee({ id: "e2", skills: ["Boarding"] }),
      makeEmployee({ id: "e3", skills: ["Boarding"] }), // extra, shouldn't be needed
    ];

    const result = generateFlexiblePoolShifts("Wednesday", TEST_DATE, demand, employees);
    expect(result).toHaveLength(2);
  });

  it("DEMAND-DRIVEN, not template-driven: assigns an employee even when their static weekly_shifts baseline marks them OFF that day — that baseline is durable fallback/legacy data now, never authoritative for whether a flexible employee is available (see duty-generation.ts's effectiveShiftForDay)", () => {
    const flight = makeFlight({});
    const requirement = makeRequirement({ total_requirement: 1 });
    const demand = aggregateDailyDemand("Wednesday", [flight], [requirement]);

    const staticallyOffEmployee = makeEmployee({
      id: "e1",
      skills: ["Boarding"],
      weekly_shifts: [{ day_of_week: "Wednesday", shift_code: null, status: "off" }],
    });
    const result = generateFlexiblePoolShifts("Wednesday", TEST_DATE, demand, [staticallyOffEmployee]);
    expect(result).toHaveLength(1);
    expect(result[0].employeeId).toBe("e1");
  });

  it("never assigns an INACTIVE employee, regardless of demand — active is a real hard exclusion, unlike the static weekly_shifts template", () => {
    const flight = makeFlight({});
    const requirement = makeRequirement({ total_requirement: 1 });
    const demand = aggregateDailyDemand("Wednesday", [flight], [requirement]);

    const inactiveEmployee = makeEmployee({ id: "inactive-1", skills: ["Boarding"], active: false });
    const result = generateFlexiblePoolShifts("Wednesday", TEST_DATE, demand, [inactiveEmployee]);
    expect(result).toHaveLength(0);
  });

  it("never assigns a non-flexible-pool employee (e.g. Transit-assigned) even if skilled", () => {
    const flight = makeFlight({});
    const requirement = makeRequirement({ total_requirement: 1 });
    const demand = aggregateDailyDemand("Wednesday", [flight], [requirement]);

    const transitEmployee = makeEmployee({ id: "t1", skills: ["Boarding"], assignment: "Transit" });
    const result = generateFlexiblePoolShifts("Wednesday", TEST_DATE, demand, [transitEmployee]);
    expect(result).toHaveLength(0);
  });

  it("SEQUENTIAL REUSE: one multi-qualified employee's single continuous shift covers three non-overlapping roles across the day, rather than three separate people", () => {
    // Check-in 04:45-07:00 (demand_forecast, T-180/T-45 from a 07:45
    // departure), Gate 07:30-08:30 (fixed_rule, T-60 from 08:30), Boarding
    // 09:00-10:00 (fixed_rule, T-60 from 10:00) -- three genuinely
    // non-overlapping windows spanning 04:45-10:00, all inside MT02's
    // 04:30-14:45 shift.
    const checkinFlight = makeFlight({ id: "ci", scheduled_departure: "07:45" });
    const checkinReq = makeRequirement({ id: "r-ci", flight_id: "ci", role: "Check-in", source: "demand_forecast", total_requirement: 1 });
    const gateFlight = makeFlight({ id: "ga", scheduled_departure: "08:30" });
    const gateReq = makeRequirement({ id: "r-ga", flight_id: "ga", role: "Gate", total_requirement: 1 });
    const boardingFlight = makeFlight({ id: "bo", scheduled_departure: "10:00" });
    const boardingReq = makeRequirement({ id: "r-bo", flight_id: "bo", role: "Boarding", total_requirement: 1 });

    const demand = aggregateDailyDemand("Wednesday", [checkinFlight, gateFlight, boardingFlight], [checkinReq, gateReq, boardingReq]);
    const employee = makeEmployee({ id: "multi-1", skills: ["Check-in", "Gate", "Boarding"] });

    const result = generateFlexiblePoolShifts("Wednesday", TEST_DATE, demand, [employee]);

    expect(result).toHaveLength(1); // one shift, not three separate assignments
    expect(result[0].shiftCode).toBe("MT02");
    expect(result[0].coversRoles.sort()).toEqual(["Boarding", "Check-in", "Gate"]);
  });

  it("STAGE 6 -> STAGE 9 FEASIBILITY: the sequential-reuse roster above actually converts into three real, non-overlapping duties for that one employee — Stage 6's output is not just plausible on paper, Stage 9 can genuinely use it", () => {
    const checkinFlight = makeFlight({ id: "ci", scheduled_departure: "07:45" });
    const checkinReq = makeRequirement({ id: "r-ci", flight_id: "ci", role: "Check-in", source: "demand_forecast", total_requirement: 1 });
    const gateFlight = makeFlight({ id: "ga", scheduled_departure: "08:30" });
    const gateReq = makeRequirement({ id: "r-ga", flight_id: "ga", role: "Gate", total_requirement: 1 });
    const boardingFlight = makeFlight({ id: "bo", scheduled_departure: "10:00" });
    const boardingReq = makeRequirement({ id: "r-bo", flight_id: "bo", role: "Boarding", total_requirement: 1 });

    const flights = [checkinFlight, gateFlight, boardingFlight];
    const requirements = [checkinReq, gateReq, boardingReq];
    const demand = aggregateDailyDemand("Wednesday", flights, requirements);
    const employee = makeEmployee({ id: "multi-1", skills: ["Check-in", "Gate", "Boarding"], rest_before_shift_hours: 24, weekly_hours: 0 });
    const generatedShifts = generateFlexiblePoolShifts("Wednesday", TEST_DATE, demand, [employee]);
    const { duties, unfilled } = generateDutiesForDay("Wednesday", requirements, flights, [employee], generatedShifts, [], CONFIG, TEST_DATE);

    expect(unfilled).toHaveLength(0); // every requirement genuinely got covered, not just "roster looked sufficient"
    expect(duties).toHaveLength(3);
    expect(new Set(duties.map((d) => d.role))).toEqual(new Set(["Check-in", "Gate", "Boarding"]));
    expect(duties.every((d) => d.employeeId === "multi-1")).toBe(true);

    // No two of this employee's duties may overlap in time.
    const windows = duties.map((d) => d.window);
    for (let i = 0; i < windows.length; i++) {
      for (let j = i + 1; j < windows.length; j++) {
        const overlaps = windows[i].start < windows[j].end && windows[j].start < windows[i].end;
        expect(overlaps).toBe(false);
      }
    }
  });

  it("SIMULTANEOUS DEMAND: two roles needing coverage in the same overlapping time window require two separate people, even when both are qualified for both roles", () => {
    // Check-in (09:00 departure -> window 06:00-08:15) and Gate (07:00
    // departure -> window 06:00-07:00) genuinely overlap 06:00-07:00.
    const checkinFlight = makeFlight({ id: "ci", scheduled_departure: "09:00" });
    const checkinReq = makeRequirement({ id: "r-ci", flight_id: "ci", role: "Check-in", source: "demand_forecast", total_requirement: 1 });
    const gateFlight = makeFlight({ id: "ga", scheduled_departure: "07:00" });
    const gateReq = makeRequirement({ id: "r-ga", flight_id: "ga", role: "Gate", total_requirement: 1 });
    const demand = aggregateDailyDemand("Wednesday", [checkinFlight, gateFlight], [checkinReq, gateReq]);

    const employees = [
      makeEmployee({ id: "multi-1", skills: ["Check-in", "Gate"] }),
      makeEmployee({ id: "multi-2", skills: ["Check-in", "Gate"] }),
    ];
    const result = generateFlexiblePoolShifts("Wednesday", TEST_DATE, demand, employees);

    expect(result).toHaveLength(2); // two people, not one double-counted
    const coveredRoles = new Set(result.flatMap((r) => r.coversRoles));
    expect(coveredRoles).toEqual(new Set(["Check-in", "Gate"]));
  });

  it("ONE UNIT PER BUCKET: with only one multi-qualified employee available for two simultaneous roles, they cover exactly one role — the other stays a genuine, honest gap, never double-counted", () => {
    const checkinFlight = makeFlight({ id: "ci", scheduled_departure: "09:00" });
    const checkinReq = makeRequirement({ id: "r-ci", flight_id: "ci", role: "Check-in", source: "demand_forecast", total_requirement: 1 });
    const gateFlight = makeFlight({ id: "ga", scheduled_departure: "07:00" });
    const gateReq = makeRequirement({ id: "r-ga", flight_id: "ga", role: "Gate", total_requirement: 1 });
    const demand = aggregateDailyDemand("Wednesday", [checkinFlight, gateFlight], [checkinReq, gateReq]);

    const employee = makeEmployee({ id: "multi-1", skills: ["Check-in", "Gate"] });
    const result = generateFlexiblePoolShifts("Wednesday", TEST_DATE, demand, [employee]);

    expect(result).toHaveLength(1); // never two assignments for one employee
    expect(result[0].coversRoles).toHaveLength(1); // never both roles credited to the same person for the same overlapping time
  });

  it("QUALIFICATION-LIMITED DEMAND: an employee qualified for only one of two roles never gets rostered for the role they can't do, even when it has real unmet demand", () => {
    const boardingFlight = makeFlight({ id: "bo", scheduled_departure: "10:00" });
    const boardingReq = makeRequirement({ id: "r-bo", flight_id: "bo", role: "Boarding", total_requirement: 1 });
    const gateFlight = makeFlight({ id: "ga", scheduled_departure: "10:00" });
    const gateReq = makeRequirement({ id: "r-ga", flight_id: "ga", role: "Gate", total_requirement: 1 });
    const demand = aggregateDailyDemand("Wednesday", [boardingFlight, gateFlight], [boardingReq, gateReq]);

    const employee = makeEmployee({ id: "e1", skills: ["Boarding"] }); // NOT qualified for Gate
    const result = generateFlexiblePoolShifts("Wednesday", TEST_DATE, demand, [employee]);

    expect(result).toHaveLength(1);
    expect(result[0].coversRoles).toEqual(["Boarding"]); // Gate's demand is left genuinely unfilled, not fabricated
  });

  it("REST GATE: a rest-blocked candidate is skipped and a legal candidate is selected instead, never the reverse", () => {
    const flight = makeFlight({ scheduled_departure: "10:00" }); // Boarding window 09:00-10:00
    const requirement = makeRequirement({ total_requirement: 1 });
    const demand = aggregateDailyDemand("Wednesday", [flight], [requirement]);

    // e1 ended a shift at 23:00 the day before -- every compatible code's
    // entree (05:45-09:00 range) is well under 15h rest since 23:00.
    const priorDayShift = new Map([
      ["e1", { shift_start: "13:45", shift_end: "23:00" }],
      ["e2", null], // e2 was OFF the prior day -- no conflict at all
    ]);
    const employees = [makeEmployee({ id: "e1", skills: ["Boarding"] }), makeEmployee({ id: "e2", skills: ["Boarding"] })];

    const result = generateFlexiblePoolShifts("Wednesday", TEST_DATE, demand, employees, priorDayShift, 15);
    expect(result).toHaveLength(1);
    expect(result[0].employeeId).toBe("e2"); // never e1 -- the rest-blocked candidate
  });

  it("CROSS-WEEK REST BOUNDARY: a priorDayShift seeded from the PREVIOUS WEEK's real last-worked shift (this window's own Monday has no 'yesterday' inside the display) still blocks an under-rested candidate", () => {
    // Exactly how rotation-context.ts seeds Monday's priorDayShift from
    // the previous week's real Sunday roster (see
    // tests/rotation-context.test.ts for that wiring) -- this proves the
    // per-day rest gate itself honors whatever it's handed, regardless of
    // which calendar week the data came from.
    const flight = makeFlight({ scheduled_departure: "10:00" });
    const requirement = makeRequirement({ total_requirement: 1 });
    const demand = aggregateDailyDemand("Monday", [flight], [requirement]);

    const priorWeekSundayShift = new Map([["e1", { shift_start: "13:45", shift_end: "23:00" }]]); // last week's Sunday
    const employee = makeEmployee({ id: "e1", skills: ["Boarding"] });

    const result = generateFlexiblePoolShifts("Monday", TEST_DATE, demand, [employee], priorWeekSundayShift, 15);
    expect(result).toHaveLength(0); // the only candidate is blocked by last week's boundary shift
  });

  it("HONEST GAP: when legal, qualified capacity is genuinely insufficient, the shortfall is never silently padded", () => {
    const flight = makeFlight({ scheduled_departure: "10:00" });
    const requirement = makeRequirement({ total_requirement: 2 }); // needs 2
    const demand = aggregateDailyDemand("Wednesday", [flight], [requirement]);

    const onlyOneQualified = [makeEmployee({ id: "e1", skills: ["Boarding"] })]; // only 1 exists
    const result = generateFlexiblePoolShifts("Wednesday", TEST_DATE, demand, onlyOneQualified);
    expect(result).toHaveLength(1); // never fabricates a second person
  });

  it("DETERMINISTIC: identical inputs (fresh Maps each call, to rule out accidental mutation) produce byte-identical output", () => {
    const flight = makeFlight({ scheduled_departure: "10:00" });
    const requirement = makeRequirement({ total_requirement: 2 });
    const demand = aggregateDailyDemand("Wednesday", [flight], [requirement]);
    const employees = [
      makeEmployee({ id: "e1", skills: ["Boarding"] }),
      makeEmployee({ id: "e2", skills: ["Boarding"] }),
      makeEmployee({ id: "e3", skills: ["Boarding"] }),
    ];

    const run1 = generateFlexiblePoolShifts("Wednesday", TEST_DATE, demand, employees, new Map(), 15, undefined, new Map(), new Map());
    const run2 = generateFlexiblePoolShifts("Wednesday", TEST_DATE, demand, employees, new Map(), 15, undefined, new Map(), new Map());

    const sortById = (arr: typeof run1) => [...arr].sort((a, b) => a.employeeId.localeCompare(b.employeeId));
    expect(sortById(run1)).toEqual(sortById(run2));
  });

  it("RANKED SHIFT-CODE FALLBACK: tries every compatible candidate code before giving up, but the rest gate applies identically to every candidate — a rest-blocked employee is never rescued by trying a worse-fit code (a later-ranked candidate never starts LATER than the top choice, so backward rest can only be equal or worse)", () => {
    // Window 05:45-14:45 matches MT01 exactly (top-ranked); MT03 and JR01
    // are also compatible (same entree, longer duration) — real fallback
    // candidates, not fabricated ones.
    const flight = makeFlight({ scheduled_departure: "14:45", boarding_window_start: "05:45", boarding_window_end: "14:45" });
    const requirement = makeRequirement({ total_requirement: 1 });
    const demand = aggregateDailyDemand("Wednesday", [flight], [requirement]);

    const employee = makeEmployee({ id: "e1", skills: ["Boarding"] });
    // Ended a shift at 23:00 the day before -- only 6h45 before 05:45,
    // hard-blocked no matter which compatible code (all share the same
    // 05:45 entree) is tried.
    const priorDayShift = new Map([["e1", { shift_start: "13:45", shift_end: "23:00" }]]);

    const result = generateFlexiblePoolShifts("Wednesday", TEST_DATE, demand, [employee], priorDayShift, 15);
    expect(result).toHaveLength(0); // genuine shortfall, never a rest-violating assignment from a fallback candidate
  });

  it("never fabricates a shift for a demand window no catalog code can cover", () => {
    // T-1h from a 03:00 departure = 02:00-03:00 — before every shift's
    // earliest start (04:30), so no catalog code can cover it.
    const flight = makeFlight({ scheduled_departure: "03:00" });
    const requirement = makeRequirement({ total_requirement: 1 });
    const demand = aggregateDailyDemand("Wednesday", [flight], [requirement]);
    const employee = makeEmployee({ id: "e1", skills: ["Boarding"] });

    const result = generateFlexiblePoolShifts("Wednesday", TEST_DATE, demand, [employee]);
    expect(result).toHaveLength(0);
  });

  it("REGRESSION (deployed bug): a Check-in demand cluster opening before every catalog code's entree is still covered by a real, later-starting code, instead of leaving a qualified/idle employee unrostered", () => {
    // AT100-style 07:15 departure: Check-in opens T-180 (04:15) and
    // closes T-45 (06:30) under DEFAULT_CHECKIN_DEMAND_POLICY. No catalog
    // code starts at or before 04:15 (earliest entree is 04:30), so the
    // OLD full-containment-only matching left this cluster with zero
    // candidate codes and rostered nobody -- even though the employee
    // below is qualified, active, and has no conflicting prior shift.
    const flight = makeFlight({ id: "at100-monday", flight_number: "AT100", scheduled_departure: "07:15" });
    const requirement = makeRequirement({ id: "req-checkin", flight_id: "at100-monday", role: "Check-in", source: "demand_forecast", total_requirement: 1 });
    const demand = aggregateDailyDemand("Wednesday", [flight], [requirement]);
    const employee = makeEmployee({ id: "e1", skills: ["Check-in"] });

    const result = generateFlexiblePoolShifts("Wednesday", TEST_DATE, demand, [employee]);
    expect(result).toHaveLength(1);
    expect(result[0].employeeId).toBe("e1");
    // MT02 (04:30-14:45) is the closest-fit code that still runs through
    // the window's 06:30 close -- exactly what scoring.ts's own
    // duty-assignment stage already treats as valid coverage.
    expect(result[0].shiftCode).toBe("MT02");
  });

  it("REGRESSION (AT870): AP02 (13:45-23:15) is chosen over AP01 (13:45-22:45) for a Gate requirement ending at 23:00, when both are legal", () => {
    // Boeing 787-9 (Dreamliner), 23:00 departure -> Gate/Boarding window
    // is T-90 = 21:30-23:00. AP01 ends 22:45, 15 minutes short of the
    // window's own close; AP02 ends 23:15, fully through it. Before this
    // fix, both scored identically (any-overlap credited the last
    // 22:30-23:00 bucket to AP01 too) and the duration tie-break then
    // picked the SHORTER, wrong one. Now AP01 only covers 2 of the 3
    // buckets (missing 22:30-23:00), AP02 covers all 3 -- AP02 must win
    // on SCORE, before duration is ever consulted.
    const flight = makeFlight({ id: "at870-tuesday", flight_number: "AT870", scheduled_departure: "23:00", aircraft: "Boeing 787-9", day_of_week: "Tuesday" });
    const requirement = makeRequirement({ id: "req-gate", flight_id: "at870-tuesday", role: "Gate", total_requirement: 1 });
    const demand = aggregateDailyDemand("Tuesday", [flight], [requirement]);
    const employee = makeEmployee({ id: "e1", skills: ["Gate"] });

    const result = generateFlexiblePoolShifts("Tuesday", TEST_DATE, demand, [employee]);
    expect(result).toHaveLength(1);
    expect(result[0].shiftCode).toBe("AP02"); // never AP01
  });

  it("REGRESSION (AT870): when AP02 is illegal (blocked by next-day rest) but AP01 is legal, AP01 is still used for what it CAN cover -- Stage 6 doesn't refuse capacity it does have, it just correctly can't claim the last bucket", () => {
    const flight = makeFlight({ id: "at870-tuesday", flight_number: "AT870", scheduled_departure: "23:00", aircraft: "Boeing 787-9", day_of_week: "Tuesday" });
    const requirement = makeRequirement({ id: "req-gate", flight_id: "at870-tuesday", role: "Gate", total_requirement: 1 });
    const demand = aggregateDailyDemand("Tuesday", [flight], [requirement]);
    const employee = makeEmployee({ id: "e1", skills: ["Gate"] });
    // Next day's own baseline shift starts at 14:00: 22:45->14:00 next
    // day is exactly 15h15 (legal for AP01); 23:15->14:00 next day is
    // only 14h45 (illegal for AP02, which is 30min longer at the end).
    const nextDayBaselineShift = new Map([["e1", { shift_start: "14:00", shift_end: "22:00" }]]);

    const result = generateFlexiblePoolShifts("Tuesday", TEST_DATE, demand, [employee], new Map(), 15, undefined, nextDayBaselineShift);
    expect(result).toHaveLength(1);
    expect(result[0].shiftCode).toBe("AP01"); // AP02 was illegal, but AP01 remains a real, legal, partially-useful option
  });

  it("PARTIAL BUCKET OVERLAP: a shift ending mid-bucket is never credited as satisfying that bucket's full simultaneous demand -- two people end up on the fully-covering code, not one alone on the partial one", () => {
    // Non-Dreamliner, 23:00 departure -> Gate window is T-60 = 22:00-23:00
    // (two 30-min buckets: 22:00-22:30 and 22:30-23:00). Needs 2 Gate
    // agents simultaneously through the WHOLE window, including its
    // final 22:30-23:00 bucket.
    const flight = makeFlight({ id: "f1", scheduled_departure: "23:00", day_of_week: "Tuesday" });
    const requirement = makeRequirement({ role: "Gate", total_requirement: 2 });
    const demand = aggregateDailyDemand("Tuesday", [flight], [requirement]);
    const employees = [makeEmployee({ id: "e1", skills: ["Gate"] }), makeEmployee({ id: "e2", skills: ["Gate"] })];

    const result = generateFlexiblePoolShifts("Tuesday", TEST_DATE, demand, employees);
    expect(result).toHaveLength(2);
    // Both must be on a code that genuinely reaches 23:00 (AP02) -- if
    // partial overlap were still credited, the solver could have settled
    // for AP01 (which "looks" sufficient under the old any-overlap rule)
    // for one or both, silently under-covering the requirement's true
    // close.
    for (const assignment of result) {
      expect(assignment.shiftCode).toBe("AP02");
    }
  });
});

describe("Stage 6 + Stage 9 integration -- AT870-shaped simultaneous demand end-to-end", () => {
  it("four AP02-capable multi-qualified employees plus additional legal idle Check-in-only candidates: Stage 6 rosters everyone needed, and the FINAL generated duties (not just Stage 6's own bookkeeping) reach full coverage for all three simultaneous roles", () => {
    // Real shape from the live AT870 trace: Check-in needs 4 (a wider,
    // demand_forecast window), Gate and Boarding each need 2 (fixed_rule,
    // narrower, overlapping windows) -- and the qualified population
    // splits into a small multi-qualified shared pool (exactly enough
    // for Gate+Boarding's combined 4) plus a larger Check-in-only pool.
    const checkinFlight = makeFlight({ id: "f-ci", scheduled_departure: "10:00", day_of_week: "Tuesday" });
    const checkinReq = makeRequirement({ id: "r-ci", flight_id: "f-ci", role: "Check-in", source: "demand_forecast", total_requirement: 4 });
    const gateFlight = makeFlight({ id: "f-ga", scheduled_departure: "10:00", day_of_week: "Tuesday" });
    const gateReq = makeRequirement({ id: "r-ga", flight_id: "f-ga", role: "Gate", total_requirement: 2 });
    const boardingFlight = makeFlight({ id: "f-bo", scheduled_departure: "10:00", day_of_week: "Tuesday" });
    const boardingReq = makeRequirement({ id: "r-bo", flight_id: "f-bo", role: "Boarding", total_requirement: 2 });
    const flights = [checkinFlight, gateFlight, boardingFlight];
    const requirements = [checkinReq, gateReq, boardingReq];

    const multiQualified = ["m1", "m2", "m3", "m4"].map((id) =>
      makeEmployee({ id, skills: ["Check-in", "Gate", "Boarding"], rest_before_shift_hours: 24, weekly_hours: 0 })
    );
    // Additional legal idle candidates -- qualified for Check-in only,
    // otherwise unused, exactly what the live trace found sitting idle.
    const checkinOnly = ["c1", "c2", "c3", "c4", "c5"].map((id) =>
      makeEmployee({ id, skills: ["Check-in"], rest_before_shift_hours: 24, weekly_hours: 0 })
    );
    const employees = [...multiQualified, ...checkinOnly];

    const demand = aggregateDailyDemand("Tuesday", flights, requirements);
    const generatedShifts = generateFlexiblePoolShifts("Tuesday", TEST_DATE, demand, employees);

    // Stage 9, using the SAME generated shifts Stage 6 actually produced.
    const { duties, unfilled } = generateDutiesForDay("Tuesday", requirements, flights, employees, generatedShifts, [], CONFIG, TEST_DATE);

    expect(unfilled).toHaveLength(0);
    expect(duties.filter((d) => d.role === "Check-in")).toHaveLength(4);
    expect(duties.filter((d) => d.role === "Gate")).toHaveLength(2);
    expect(duties.filter((d) => d.role === "Boarding")).toHaveLength(2);

    // No employee double-booked across these simultaneous duties.
    const byEmployee = new Map<string, number>();
    for (const d of duties) byEmployee.set(d.employeeId, (byEmployee.get(d.employeeId) ?? 0) + 1);
    for (const count of byEmployee.values()) expect(count).toBe(1);
  });
});
