import { describe, it, expect } from "vitest";
import { generateForeignCompanyShifts, generateProfilingMesureShifts } from "../lib/planning/specialized-team-generation";
import { resolveHardWorkCaps } from "../lib/planning/hard-work-caps";
import { aggregateDailyDemand } from "../lib/planning/demand-aggregation";
import { flightDateFor } from "../lib/flight-date";
import { CONFIG } from "../lib/seed-data";
import { Employee, Flight, StaffingRequirement } from "../lib/types";

/**
 * Regression coverage for the fairness-rotation fix (2026-09-21): before
 * this fix, `assignPoolToWindow`/`assignPoolToWindowWithRoles` always
 * tried a team's pool in the SAME fixed order every day, so when a
 * company's confirmed headcount need is smaller than its team size (the
 * normal case), the same first N employees got every duty, every day,
 * every week -- confirmed live in production (RAM Handling, Moses,
 * 2026-09-21): a 5-person Air France team (headcount 3/flight) always
 * scheduled the same 3 employees (Fadwa/Khalid/Marouane Idrissi) while
 * the other 2 (Tarik/Widad Idrissi) sat OFF every single day, all week.
 *
 * This is a fairness/rotation ordering fix, not a business-rule guess --
 * it changes WHICH already-eligible, already-interchangeable team members
 * get picked first, using cumulative assigned hours this window, never
 * inventing a new headcount or weight.
 */
function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "emp", name: "Test", skills: ["Boarding"], assignment: "General T1 Pool",
    shift_code: null, shift_start: null, shift_end: null, rest_before_shift_hours: null,
    weekly_hours: null, is_duty_officer: false, off_days: [], foreign_company_authorizations: [],
    active: true, weekly_shifts: [],
    ...overrides,
  };
}

function makeFlight(overrides: Partial<Flight>): Flight {
  return {
    id: "f1", flight_number: "AF1980", airline: "Air France", route: "CMN → ORY",
    origin: "CMN", destination: "ORY", aircraft: "Airbus A319", equipment_code: null,
    registration: null, callsign: null, terminal: "T1", scheduled_departure: "12:10",
    scheduled_arrival: "15:00", gate: null, boarding_window_start: null, boarding_window_end: null,
    status: "scheduled", booking_pressure: "normal", day_of_week: "Monday", flight_date: "2026-09-21",
    week_start: "2026-09-21", operator_type: "self_managed", destination_category: null,
    booked_passengers: null, seat_capacity: null,
    ...overrides,
  };
}

const TEST_WEEK_START = "2026-09-21";
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

describe("generateForeignCompanyShifts — fairness rotation across a team larger than its headcount need", () => {
  it("spreads duties across all 5 Air France employees over the week instead of always picking the same first 3", () => {
    // Air France's real confirmed headcount is 3/flight (company-config.ts).
    // Reproduce the exact live scenario: a 5-person team, an AF flight
    // every day of the week, foreign_company_authorizations required.
    const team = ["Fadwa", "Khalid", "Marouane", "Tarik", "Widad"].map((name, i) =>
      makeEmployee({
        id: `af-${i}`,
        name: `${name} Idrissi`,
        assignment: "Air France",
        skills: ["Boarding"],
        foreign_company_authorizations: ["Air France"],
      })
    );
    const flights = DAYS.map((day, i) => makeFlight({ id: `af-flight-${i}`, day_of_week: day }));

    const { generatedShiftsByDay, conflicts } = generateForeignCompanyShifts(
      DAYS,
      team,
      flights,
      ["Air France"],
      15,
      TEST_WEEK_START
    );

    expect(conflicts.filter((c) => c.team === "Air France")).toEqual([]);

    const totalDutiesByEmployee: Record<string, number> = {};
    for (const day of DAYS) {
      for (const g of generatedShiftsByDay[day] ?? []) {
        totalDutiesByEmployee[g.employeeId] = (totalDutiesByEmployee[g.employeeId] ?? 0) + 1;
      }
    }

    // All 5 team members must get at least one duty across the week --
    // nobody permanently excluded just by fixed pool order.
    for (const e of team) {
      expect(totalDutiesByEmployee[e.id] ?? 0).toBeGreaterThan(0);
    }

    // With 7 days x 3 slots = 21 duty-days spread over 5 people, the
    // fairest possible split is 4 or 5 duties each -- assert the spread
    // is real (max-min small), not the old bug's 7/7/7/0/0.
    const counts = team.map((e) => totalDutiesByEmployee[e.id] ?? 0);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it("still respects a confirmed team-role split (Gulf Air) while rotating fairly within each role group", () => {
    const aces = Array.from({ length: 7 }, (_, i) =>
      makeEmployee({ id: `gf-ace-${i}`, name: `Ace ${i}`, assignment: "Gulf Air", team_role: "ace", foreign_company_authorizations: ["Gulf Air"] })
    );
    const leaders = [makeEmployee({ id: "gf-leader-0", name: "Leader", assignment: "Gulf Air", team_role: "leader", foreign_company_authorizations: ["Gulf Air"] })];
    const team = [...aces, ...leaders];
    const flightDays = ["Monday", "Thursday", "Saturday"];
    const flights = flightDays.map((day, i) => makeFlight({ id: `gf-flight-${i}`, airline: "Gulf Air", day_of_week: day }));

    const { generatedShiftsByDay, conflicts } = generateForeignCompanyShifts(DAYS, team, flights, ["Gulf Air"], 15, TEST_WEEK_START);

    expect(conflicts.filter((c) => c.team === "Gulf Air")).toEqual([]);
    // All 7 ACE slots filled every flight day, and the leader slot never
    // absorbed by an ACE or vice versa (role split still enforced).
    for (const day of flightDays) {
      const scheduled = generatedShiftsByDay[day] ?? [];
      expect(scheduled.filter((g) => aces.some((a) => a.id === g.employeeId)).length).toBe(7);
      expect(scheduled.filter((g) => leaders.some((l) => l.id === g.employeeId)).length).toBe(1);
    }
  });
});

/**
 * CAP-PACED REST PLANNING (2026-09-25 lockstep fix — cap-paced-rest.ts):
 * under the real hard caps, a capacity-constrained team now gets a
 * deterministic staggered rest plan instead of the pure daily least-used
 * greedy. These prove the 2026-09-21 fairness goal still holds on that new
 * path: nobody permanently favoured, the same first N never always picked,
 * and the original Tarik/Widad Idrissi scenario stays fixed.
 */
describe("fairness still holds when cap-paced rest planning is active (real 42h / 5-day hard caps)", () => {
  const caps = resolveHardWorkCaps(CONFIG);
  const count = (byDay: Record<string, { employeeId: string }[]>, id: string) => DAYS.filter((d) => (byDay[d] ?? []).some((g) => g.employeeId === id)).length;

  it("the original Air France scenario (5 members, 3/flight, a flight every day): 20 legal person-days < 21 needed, the plan is active — every member still gets 4 duties, Tarik and Widad included", () => {
    const team = ["Fadwa", "Khalid", "Marouane", "Tarik", "Widad"].map((name, i) =>
      makeEmployee({ id: `af-${i}`, name: `${name} Idrissi`, assignment: "Air France", foreign_company_authorizations: ["Air France"] })
    );
    const flights = DAYS.map((day, i) => makeFlight({ id: `af-flight-${i}`, day_of_week: day, flight_date: flightDateFor(TEST_WEEK_START, day) }));
    const { generatedShiftsByDay, conflicts } = generateForeignCompanyShifts(DAYS, team, flights, ["Air France"], 15, TEST_WEEK_START, new Map(), undefined, undefined, { caps, incomingStreakByEmployee: new Map() });
    const counts = team.map((e) => count(generatedShiftsByDay, e.id));
    expect(counts).toEqual([4, 4, 4, 4, 4]);
    // The pacing is really engaged here (one day is honestly short, spread rather than a zero day).
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].capPacing).toBeDefined();
    // Not the same first 3 every day: each day's crew differs from Monday's on some day.
    const crew = (d: string) => generatedShiftsByDay[d].map((g) => g.employeeId).sort().join(",");
    expect(new Set(DAYS.map(crew)).size).toBeGreaterThan(1);
  });

  it("a whole-team-every-day Profiling team (12 members, 12 needed daily — Mesure's real shape on the stress week): worked days are spread within 1 across all 12, and no member rests on exactly the same days as everyone else", () => {
    const pool = Array.from({ length: 12 }, (_, i) => makeEmployee({ id: `p-${i}`, name: `P ${i}`, assignment: "Profiling", skills: ["Profiling"] }));
    const flights = DAYS.map((day) => makeFlight({ id: `ram-${day}`, airline: "Royal Air Maroc", flight_number: "AT201", day_of_week: day, flight_date: flightDateFor(TEST_WEEK_START, day), operator_type: "atlas_managed", scheduled_departure: "14:30" }));
    const reqs: StaffingRequirement[] = flights.map((f) => ({ id: `r-${f.day_of_week}`, flight_id: f.id, role: "Profiling", baseline_requirement: 12, additional_requirement: 0, total_requirement: 12, source: "fixed_rule", reasoning: "", needs_configuration: false }));
    const demandByDay = Object.fromEntries(DAYS.map((d) => [d, aggregateDailyDemand(d, flights, reqs)]));
    const { generatedShiftsByDay } = generateProfilingMesureShifts(DAYS, pool, demandByDay, 15, TEST_WEEK_START, new Map(), { caps, incomingStreakByEmployee: new Map() });
    const counts = pool.map((e) => count(generatedShiftsByDay, e.id));
    expect(Math.min(...counts)).toBeGreaterThan(0);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    const restPattern = (id: string) => DAYS.filter((d) => !generatedShiftsByDay[d].some((g) => g.employeeId === id)).join(",");
    expect(new Set(pool.map((e) => restPattern(e.id))).size).toBeGreaterThan(1);
    // And every day keeps real coverage (the lockstep would leave the last days at 0).
    for (const d of DAYS) expect(generatedShiftsByDay[d].length, d).toBeGreaterThan(0);
  });

  it("with the hard caps supplied but capacity sufficient (plan inactive), the 2026-09-21 least-used rotation is exactly what runs — same output as without caps, still fair", () => {
    const team = ["Fadwa", "Khalid", "Marouane", "Tarik", "Widad"].map((name, i) =>
      makeEmployee({ id: `af-${i}`, name: `${name} Idrissi`, assignment: "Air France", foreign_company_authorizations: ["Air France"] })
    );
    const flightDays = ["Monday", "Wednesday", "Friday", "Sunday"];
    const flights = flightDays.map((day, i) => makeFlight({ id: `af-flight-${i}`, day_of_week: day, flight_date: flightDateFor(TEST_WEEK_START, day) }));
    const withCaps = generateForeignCompanyShifts(DAYS, team, flights, ["Air France"], 15, TEST_WEEK_START, new Map(), undefined, undefined, { caps, incomingStreakByEmployee: new Map() });
    const withoutCaps = generateForeignCompanyShifts(DAYS, team, flights, ["Air France"], 15, TEST_WEEK_START);
    expect(withCaps).toEqual(withoutCaps);
    const counts = team.map((e) => count(withCaps.generatedShiftsByDay, e.id));
    expect(Math.min(...counts)).toBeGreaterThan(0);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });
});
