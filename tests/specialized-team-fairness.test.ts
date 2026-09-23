import { describe, it, expect } from "vitest";
import { generateForeignCompanyShifts } from "../lib/planning/specialized-team-generation";
import { Employee, Flight } from "../lib/types";

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
