import { describe, it, expect } from "vitest";
import { generateForeignCompanyShifts } from "../lib/planning/specialized-team-generation";
import { CONFIGURED_COMPANIES, getCompanyRequiredAgents } from "../lib/company-config";
import { CONFIG } from "../lib/seed-data";
import { Employee, Flight } from "../lib/types";

const TEST_WEEK_START = "2026-09-21";

/**
 * Regression coverage for Fix 1 (2026-09-22 audit -- see
 * docs/known-limitations/roster-planning-vs-duty-allocation.md):
 * foreign-company employees get a normal RAM weekly roster
 * (5 WORK + 2 OFF), constrained (not replaced) by company flights,
 * instead of being left with no roster entry (= OFF) on every day their
 * own company doesn't need them.
 *
 * "Qatar Airways" below is used because it has NO confirmed ACE/Leader
 * role split (unlike Gulf Air), so the top-up's day-count logic isn't
 * entangled with an unrelated role-composition concern. The generic
 * mechanism under test applies identically to every entry in
 * CONFIGURED_COMPANIES (see the last test in this file).
 */

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const QATAR_HEADCOUNT = getCompanyRequiredAgents("Qatar Airways")!;

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "emp", name: "Test", skills: ["Boarding"], assignment: "General T1 Pool",
    shift_code: null, shift_start: null, shift_end: null, rest_before_shift_hours: null,
    weekly_hours: null, is_duty_officer: false, off_days: [], foreign_company_authorizations: [],
    active: true, weekly_shifts: [],
    ...overrides,
  };
}

function makeQatarFlight(overrides: Partial<Flight>): Flight {
  return {
    id: "f1", flight_number: "QR105", airline: "Qatar Airways", route: "CMN → DOH",
    origin: "CMN", destination: "DOH", aircraft: "Airbus A320", equipment_code: null,
    registration: null, callsign: null, terminal: "T1", scheduled_departure: "09:00",
    scheduled_arrival: "18:00", gate: null, boarding_window_start: null, boarding_window_end: null,
    status: "scheduled", booking_pressure: "normal", day_of_week: "Wednesday", flight_date: "2026-09-24",
    week_start: "2026-09-21", operator_type: "self_managed", destination_category: null,
    booked_passengers: null, seat_capacity: null,
    ...overrides,
  };
}

describe("Fix 1 -- foreign-company employees get a normal RAM roster, not OFF, on non-flight days", () => {
  it("an employee not needed for their company's flight this week gets a real RAM-compatible WORK shift instead of no roster entry", () => {
    // One flight, one day, with more employees in the pool than the
    // confirmed headcount -- at least one is guaranteed to never be
    // selected for the flight itself.
    const poolSize = QATAR_HEADCOUNT + 1;
    const pool = Array.from({ length: poolSize }, (_, i) =>
      makeEmployee({ id: `qa-${i}`, assignment: "Qatar Airways", foreign_company_authorizations: ["Qatar Airways"] })
    );
    const flights = [makeQatarFlight({ id: "qr-wed", day_of_week: "Wednesday" })];

    const { generatedShiftsByDay, conflicts } = generateForeignCompanyShifts(
      DAYS, pool, flights, ["Qatar Airways"], CONFIG.minimum_rest_hours, TEST_WEEK_START, new Map(), CONFIG
    );
    expect(conflicts).toEqual([]);

    // Every employee must have SOME rostered day this week -- nobody is
    // left with zero entries across all 7 days any more.
    for (const e of pool) {
      const daysScheduled = DAYS.filter((d) => (generatedShiftsByDay[d] ?? []).some((g) => g.employeeId === e.id));
      expect(daysScheduled.length, `${e.id} has no rostered day at all this week`).toBeGreaterThan(0);
    }
  });

  it("without a config argument, the top-up is a strict no-op (backward compatibility -- every existing caller/test unaffected)", () => {
    const pool = [makeEmployee({ id: "qa-0", assignment: "Qatar Airways", foreign_company_authorizations: ["Qatar Airways"] })];
    const flights = [makeQatarFlight({ id: "qr-wed", day_of_week: "Wednesday" })];
    const { generatedShiftsByDay } = generateForeignCompanyShifts(DAYS, pool, flights, ["Qatar Airways"], CONFIG.minimum_rest_hours, TEST_WEEK_START);
    const scheduledDays = DAYS.filter((d) => (generatedShiftsByDay[d] ?? []).some((g) => g.employeeId === "qa-0"));
    expect(scheduledDays).toEqual(["Wednesday"]); // only the real flight day -- no top-up without config
  });
});

describe("Fix 1 -- full week lands each foreign-company employee at (or honestly short of) 5 WORK + 2 OFF, soft consecutive-OFF preference", () => {
  it("with a flight every day, every employee already at/above the confirmed target keeps their real flight-driven days (top-up never removes real coverage)", () => {
    const pool = Array.from({ length: QATAR_HEADCOUNT }, (_, i) =>
      makeEmployee({ id: `qa-${i}`, assignment: "Qatar Airways", foreign_company_authorizations: ["Qatar Airways"] })
    );
    const flights = DAYS.map((day, i) => makeQatarFlight({ id: `qr-${i}`, day_of_week: day }));

    const { generatedShiftsByDay, conflicts } = generateForeignCompanyShifts(
      DAYS, pool, flights, ["Qatar Airways"], CONFIG.minimum_rest_hours, TEST_WEEK_START, new Map(), CONFIG
    );
    expect(conflicts).toEqual([]);

    for (const e of pool) {
      const workedDays = DAYS.filter((d) => (generatedShiftsByDay[d] ?? []).some((g) => g.employeeId === e.id));
      expect(workedDays.length).toBeGreaterThanOrEqual(DAYS.length - CONFIG.normal_weekly_off_days);
    }
  });

  it("a team member never needed by the flight (pool larger than headcount) is topped up toward 5 WORK + 2 OFF with a real catalog shift", () => {
    const pool = Array.from({ length: QATAR_HEADCOUNT }, (_, i) =>
      makeEmployee({ id: `qa-${i}`, assignment: "Qatar Airways", foreign_company_authorizations: ["Qatar Airways"] })
    );
    // Extra, never-needed member -- headcount stays QATAR_HEADCOUNT, so
    // this person is NEVER selected by flight-driven assignment.
    pool.push(makeEmployee({ id: "qa-extra", assignment: "Qatar Airways", foreign_company_authorizations: ["Qatar Airways"] }));
    const flights = DAYS.map((day, i) => makeQatarFlight({ id: `qr-${i}`, day_of_week: day }));

    const { generatedShiftsByDay } = generateForeignCompanyShifts(
      DAYS, pool, flights, ["Qatar Airways"], CONFIG.minimum_rest_hours, TEST_WEEK_START, new Map(), CONFIG
    );
    const workedDays = DAYS.filter((d) => (generatedShiftsByDay[d] ?? []).some((g) => g.employeeId === "qa-extra"));
    expect(workedDays.length).toBe(DAYS.length - CONFIG.normal_weekly_off_days); // exactly 5 -- the confirmed target
    const offDays = DAYS.filter((d) => !workedDays.includes(d));
    expect(offDays.length).toBe(CONFIG.normal_weekly_off_days);
  });

  it("every configured foreign company gets the same top-up behavior -- generic, no per-airline special-casing", () => {
    for (const company of CONFIGURED_COMPANIES) {
      const headcount = getCompanyRequiredAgents(company)!;
      const pool = Array.from({ length: headcount + 1 }, (_, i) =>
        makeEmployee({ id: `${company}-${i}`, assignment: company, foreign_company_authorizations: [company] })
      );
      const flights = [makeQatarFlight({ id: `${company}-flight`, airline: company, day_of_week: "Wednesday" })];
      const { generatedShiftsByDay } = generateForeignCompanyShifts(
        DAYS, pool, flights, [company], CONFIG.minimum_rest_hours, TEST_WEEK_START, new Map(), CONFIG
      );
      // The always-unneeded extra member (never selected on the one flight
      // day) must still land on a real worked day somewhere this week.
      const extraId = `${company}-${headcount}`;
      const workedDays = DAYS.filter((d) => (generatedShiftsByDay[d] ?? []).some((g) => g.employeeId === extraId));
      expect(workedDays.length, `${company}: extra team member never topped up`).toBeGreaterThan(0);
    }
  });
});

describe("Fix 1 -- real flight-day coverage is unchanged (regression)", () => {
  it("on a real flight day, the N selected employees' company duty still correctly covers the real protected window", () => {
    const pool = Array.from({ length: QATAR_HEADCOUNT }, (_, i) =>
      makeEmployee({ id: `qa-${i}`, assignment: "Qatar Airways", foreign_company_authorizations: ["Qatar Airways"] })
    );
    const flights = [makeQatarFlight({ id: "qr-wed", day_of_week: "Wednesday", scheduled_departure: "09:00" })];
    const { generatedShiftsByDay, conflicts } = generateForeignCompanyShifts(
      DAYS, pool, flights, ["Qatar Airways"], CONFIG.minimum_rest_hours, TEST_WEEK_START, new Map(), CONFIG
    );
    expect(conflicts).toEqual([]);
    const wed = generatedShiftsByDay["Wednesday"] ?? [];
    expect(wed.filter((g) => g.coversRoles.includes("Qatar Airways")).length).toBe(QATAR_HEADCOUNT);
  });
});
