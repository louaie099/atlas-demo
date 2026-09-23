import { describe, it, expect } from "vitest";
import { generateFlexiblePoolShifts, PriorDayShiftMap } from "../lib/planning/shift-generation";
import { aggregateDailyDemand } from "../lib/planning/demand-aggregation";
import { Employee, Flight, StaffingRequirement } from "../lib/types";

/**
 * Regression coverage for the STAGE-6 T1 AGGREGATE DEMAND BIAS fix (see
 * shift-generation.ts's own doc comment on `t1DemandByBucket`): the
 * PRIMARY shift-code chooser (`generateFlexiblePoolShifts`) previously had
 * no way to know about T1 Check-in's aggregate demand at all (that role's
 * `demandByRole["Check-in"]` has been structurally empty since the
 * per-flight Check-in model was cut over to the zone model) — this is what
 * left early-morning T1 Check-in severely understaffed on real data even
 * though legally-available flexible-pool employees existed.
 *
 * These tests exercise `generateFlexiblePoolShifts` directly with a
 * synthetic `t1DemandByBucket` profile (the same shape
 * zone-demand-aggregation.ts's `aggregateT1DemandProfileForDay` produces),
 * rather than going through the full weekly pipeline, so the bias itself
 * is pinned down in isolation from everything else in the pipeline.
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
    flight_date: "2026-09-03",
    week_start: "2026-09-01",
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
    baseline_requirement: 2,
    additional_requirement: 0,
    total_requirement: 2,
    source: "fixed_rule",
    reasoning: "",
    needs_configuration: false,
    ...overrides,
  };
}

const BUCKETS_PER_DAY = 48;

/** A synthetic aggregate T1 demand profile: `required` in every 30-min bucket between [startTime, endTime), zero elsewhere — same shape aggregateT1DemandProfileForDay produces. */
function makeT1Profile(startTime: string, endTime: string, required: number): number[] {
  const toMin = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  };
  const startIdx = toMin(startTime) / 30;
  const endIdx = toMin(endTime) / 30;
  return Array.from({ length: BUCKETS_PER_DAY }, (_, i) => (i >= startIdx && i < endIdx ? required : 0));
}

describe("generateFlexiblePoolShifts — Stage-6 T1 aggregate demand bias (primary pass)", () => {
  it("pulls an otherwise-idle, Check-in-eligible employee onto an early shift code (MT02) purely to cover a real early-morning T1 aggregate demand peak, when nothing else needed them that day", () => {
    // No real per-flight (Gate/Boarding/Profiling/Mesure) demand at all.
    const demand = aggregateDailyDemand("Wednesday", [], []);
    const t1DemandByBucket = makeT1Profile("04:30", "06:00", 2);

    const employee = makeEmployee({ id: "e1", skills: ["Check-in"] });

    // WITHOUT the bias (omitted t1DemandByBucket): zero real demand means
    // zero score for every candidate -- nobody gets rostered, exactly the
    // pre-fix behavior (T1 aggregate demand invisible to this function).
    const before = generateFlexiblePoolShifts("Wednesday", demand, [employee]);
    expect(before).toHaveLength(0);

    // WITH the bias: the same employee is now pulled onto MT02 (04:30
    // start -- the shortest-duration legal code that actually covers the
    // demand peak) purely to sit across the early T1 window.
    const after = generateFlexiblePoolShifts(
      "Wednesday",
      demand,
      [employee],
      new Map(),
      0,
      undefined,
      new Map(),
      new Map(),
      t1DemandByBucket
    );
    expect(after).toHaveLength(1);
    expect(after[0].employeeId).toBe("e1");
    expect(after[0].shiftCode).toBe("MT02");
    expect(after[0].coversRoles).toContain("Check-in");
  });

  it("never pulls someone OFF, or ahead of someone needed for, a real hard Gate/Boarding requirement -- the T1 bias only ever breaks ties among candidates that ALREADY cover the hard requirement equally", () => {
    // One real Gate requirement, window 08:30-09:30 (T-60 standard
    // aircraft, fixed_rule).
    const gateFlight = makeFlight({ id: "ga", scheduled_departure: "09:30" });
    const gateReq = makeRequirement({ id: "r-ga", flight_id: "ga", role: "Gate", total_requirement: 1 });
    const demand = aggregateDailyDemand("Wednesday", [gateFlight], [gateReq]);
    const t1DemandByBucket = makeT1Profile("04:30", "06:00", 3);

    const employee = makeEmployee({ id: "multi-1", skills: ["Check-in", "Gate"] });

    // WITHOUT the bias: several legal codes cover the Gate window equally
    // (score 1) -- shortest-duration tie-break picks NR01 (08:00-16:45),
    // which does NOT reach back into the early T1 window at all.
    const before = generateFlexiblePoolShifts("Wednesday", demand, [employee]);
    expect(before).toHaveLength(1);
    expect(before[0].shiftCode).toBe("NR01");

    // WITH the bias: MT02 (04:30-14:45) covers the SAME Gate requirement
    // (hard score still exactly 1 -- the Gate duty is never left uncovered
    // or handed to someone else) AND the early T1 peak, so it now
    // outranks NR01's otherwise-equal hard coverage.
    const after = generateFlexiblePoolShifts(
      "Wednesday",
      demand,
      [employee],
      new Map(),
      0,
      undefined,
      new Map(),
      new Map(),
      t1DemandByBucket
    );
    expect(after).toHaveLength(1);
    expect(after[0].employeeId).toBe("multi-1");
    expect(after[0].shiftCode).toBe("MT02");
    expect(after[0].coversRoles.sort()).toEqual(["Check-in", "Gate"]);
  });

  it("NEVER fabricates an illegal early shift when no legally-rested candidate can actually cover the T1 peak -- the shortage stays real and honest instead", () => {
    const demand = aggregateDailyDemand("Wednesday", [], []);
    const t1DemandByBucket = makeT1Profile("04:30", "06:00", 2);

    const employee = makeEmployee({ id: "e1", skills: ["Check-in"] });

    // Yesterday's real shift ended at 18:15 (NR02) -- with a 15h rest
    // floor, the earliest legal entree today is 09:15, so NOTHING that
    // covers the 04:30-06:00 T1 peak is legally available; only the
    // 13:45-start codes (AP01/AP02) are legal, and neither touches the
    // early peak at all.
    const priorDayShift: PriorDayShiftMap = new Map([["e1", { shift_start: "13:45", shift_end: "18:15" }]]);
    const minimumRestHours = 15;

    const after = generateFlexiblePoolShifts(
      "Wednesday",
      demand,
      [employee],
      priorDayShift,
      minimumRestHours,
      undefined,
      new Map(),
      new Map(),
      t1DemandByBucket
    );

    // No real hard demand and no LEGAL way to cover the T1 peak -- the
    // employee is genuinely left OFF rather than illegally rostered onto
    // an under-rested early code just to chase the soft T1 signal. The
    // early-morning shortage this test set up is real and must surface
    // honestly downstream (checkin-capacity-timeline.ts), never hidden by
    // fabricating an illegal assignment here.
    expect(after).toHaveLength(0);
  });

  it("a candidate covering MORE real hard-role demand always outranks one covering less, however much T1 aggregate demand the weaker one would also cover -- T1 demand can bias a TIE, never overturn a genuine hard-coverage advantage", () => {
    // Two simultaneous Gate flights needing 2 agents at the SAME window --
    // e1 is qualified for Gate (can help cover both units across the
    // day's aggregate demand); e2 is Check-in-only and would only ever
    // contribute the soft T1 signal.
    const gateFlight1 = makeFlight({ id: "ga1", scheduled_departure: "09:30" });
    const gateFlight2 = makeFlight({ id: "ga2", scheduled_departure: "09:30" });
    const gateReq1 = makeRequirement({ id: "r-ga1", flight_id: "ga1", role: "Gate", total_requirement: 1 });
    const gateReq2 = makeRequirement({ id: "r-ga2", flight_id: "ga2", role: "Gate", total_requirement: 1 });
    const demand = aggregateDailyDemand("Wednesday", [gateFlight1, gateFlight2], [gateReq1, gateReq2]);
    const t1DemandByBucket = makeT1Profile("04:30", "06:00", 5); // deliberately large soft signal

    const gateEmployee = makeEmployee({ id: "gate-1", skills: ["Gate"] });
    const checkinOnlyEmployee = makeEmployee({ id: "checkin-1", skills: ["Check-in"] });

    const result = generateFlexiblePoolShifts(
      "Wednesday",
      demand,
      [gateEmployee, checkinOnlyEmployee],
      new Map(),
      0,
      undefined,
      new Map(),
      new Map(),
      t1DemandByBucket
    );

    // Both real Gate units are covered by the Gate-qualified employee
    // (their single shift covers the whole simultaneous 2-unit bucket),
    // and the Check-in-only employee is STILL separately pulled in for
    // the early T1 peak -- the large soft T1 weight never displaces the
    // Gate-qualified candidate from being selected for the hard demand.
    const gateAssignment = result.find((r) => r.employeeId === "gate-1");
    expect(gateAssignment).toBeDefined();
    expect(gateAssignment!.coversRoles).toContain("Gate");

    const checkinAssignment = result.find((r) => r.employeeId === "checkin-1");
    expect(checkinAssignment).toBeDefined();
    expect(checkinAssignment!.coversRoles).toEqual(["Check-in"]);
  });
});
