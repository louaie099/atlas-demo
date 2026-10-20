import { describe, it, expect } from "vitest";
import {
  resolveHardWorkCaps,
  wouldExceedShiftDurationCap,
  isNightShift,
  nextConsecutiveNightShiftStreak,
  wouldExceedConsecutiveNightShiftCap,
  HardCapExclusion,
} from "../lib/planning/hard-work-caps";
import { generateFlexiblePoolShifts } from "../lib/planning/shift-generation";
import { aggregateDailyDemand } from "../lib/planning/demand-aggregation";
import { Employee, Flight, StaffingRequirement } from "../lib/types";

// Post-regime (>= 2026-09-20) shift codes: MT03 = 05:45-14:45 (9h, daytime),
// AP01 = 13:45-22:45 (9h, daytime), NT01 = 17:45-06:30 overnight (~12.75h,
// clearly overlaps the default 23:00-05:00 night window).
const DATE = "2026-10-21";

describe("lib/planning/hard-work-caps — LABOR RULES v2 additions", () => {
  describe("resolveHardWorkCaps", () => {
    it("defaults the two new caps to null (not configured) when absent from the config, never a guessed number", () => {
      const caps = resolveHardWorkCaps({});
      expect(caps.maxContinuousShiftHours).toBeNull();
      expect(caps.maxConsecutiveNightShifts).toBeNull();
    });

    it("reads a real configured value straight through", () => {
      const caps = resolveHardWorkCaps({ max_continuous_shift_hours: 12, max_consecutive_night_shifts: 3 });
      expect(caps.maxContinuousShiftHours).toBe(12);
      expect(caps.maxConsecutiveNightShifts).toBe(3);
    });
  });

  describe("wouldExceedShiftDurationCap", () => {
    it("never excludes anything when the cap is unconfigured (null)", () => {
      expect(wouldExceedShiftDurationCap("NT01", DATE, null)).toBe(false);
    });

    it("excludes a shift whose scheduled span exceeds the configured cap", () => {
      expect(wouldExceedShiftDurationCap("NT01", DATE, 10)).toBe(true); // ~12.75h > 10h
      expect(wouldExceedShiftDurationCap("MT03", DATE, 10)).toBe(false); // 9h <= 10h
    });

    it("a shift exactly at the cap is not excluded (a ceiling, not a strict-less-than)", () => {
      expect(wouldExceedShiftDurationCap("MT03", DATE, 9)).toBe(false);
    });
  });

  describe("isNightShift", () => {
    it("classifies an overnight shift overlapping the default 23:00-05:00 window as a night shift", () => {
      expect(isNightShift("NT01", DATE)).toBe(true);
    });

    it("classifies a daytime shift with no overlap as NOT a night shift", () => {
      expect(isNightShift("MT03", DATE)).toBe(false);
      expect(isNightShift("AP01", DATE)).toBe(false);
    });
  });

  describe("nextConsecutiveNightShiftStreak / wouldExceedConsecutiveNightShiftCap", () => {
    it("increments on a worked night shift, resets on anything else, mirroring nextConsecutiveWorkDayStreak's shape", () => {
      expect(nextConsecutiveNightShiftStreak(0, true)).toBe(1);
      expect(nextConsecutiveNightShiftStreak(2, true)).toBe(3);
      expect(nextConsecutiveNightShiftStreak(3, false)).toBe(0);
    });

    it("never excludes anything when the cap is unconfigured (null)", () => {
      expect(wouldExceedConsecutiveNightShiftCap(5, true, null)).toBe(false);
    });

    it("excludes the (cap + 1)th consecutive night shift, never a day that isn't itself a night shift", () => {
      expect(wouldExceedConsecutiveNightShiftCap(2, true, 3)).toBe(false); // would be the 3rd -- at the cap, not over it
      expect(wouldExceedConsecutiveNightShiftCap(3, true, 3)).toBe(true); // would be the 4th -- over the cap
      expect(wouldExceedConsecutiveNightShiftCap(10, false, 3)).toBe(false); // not even a night shift today
    });
  });

  describe("Stage 6 wiring (generateFlexiblePoolShifts) — the two new caps actually gate real candidate selection", () => {
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
        status: "scheduled", booking_pressure: "normal", day_of_week: "Wednesday", flight_date: DATE, week_start: "2026-10-19",
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

    it("maxContinuousShiftHours: unconfigured (null) never excludes; a cap below every candidate's span excludes everyone and records the right exclusion reason", () => {
      const flight = makeFlight({});
      const demand = aggregateDailyDemand("Wednesday", [flight], [makeRequirement({})]);
      const employee = makeEmployee({ id: "e1" });

      const uncapped = generateFlexiblePoolShifts("Wednesday", DATE, demand, [employee]);
      expect(uncapped.length).toBe(1); // ordinary generation, no hardCaps at all

      const caps = { maxConsecutiveWorkDays: 999, maxContinuousShiftHours: 1, maxConsecutiveNightShifts: null };
      const exclusionsOut: HardCapExclusion[] = [];
      const capped = generateFlexiblePoolShifts(
        "Wednesday", DATE, demand, [employee], new Map(), 15, undefined, new Map(), new Map(), undefined, undefined, undefined,
        { caps, streakEnteringDay: new Map([["e1", 0]]), exclusionsOut }
      );
      expect(capped).toHaveLength(0); // every real shift code is longer than a 1-hour cap
      expect(exclusionsOut).toEqual([{ employeeId: "e1", dayOfWeek: "Wednesday", population: "flexible_pool", reason: "max_continuous_shift_hours" }]);
    });

    it("maxConsecutiveNightShifts: a genuine overnight-only demand scenario is excluded once the streak would exceed a configured cap, and falls back to an honest gap", () => {
      // Mirrors tests/overnight-shift-activation.test.ts's own pattern for
      // forcing a genuinely-overnight code: real early-morning demand the
      // following day that only an overnight shift started today can reach.
      const mondayFlight = makeFlight({ id: "f-mon", scheduled_departure: "14:00", boarding_window_start: "13:00", boarding_window_end: "14:00", day_of_week: "Monday", flight_date: DATE });
      const mondayDemand = aggregateDailyDemand("Monday", [mondayFlight], [makeRequirement({ id: "r-mon", flight_id: "f-mon" })]);
      const tuesdayFlight = makeFlight({
        id: "f-tue", flight_number: "AP587", scheduled_departure: "01:01", day_of_week: "Tuesday", flight_date: "2026-10-22",
        boarding_window_start: "00:01", boarding_window_end: "01:01",
      });
      const tuesdayDemand = aggregateDailyDemand("Tuesday", [tuesdayFlight], [makeRequirement({ id: "r-tue", flight_id: "f-tue" })]);
      const employee = makeEmployee({ id: "e1" });

      const uncapped = generateFlexiblePoolShifts(
        "Monday", DATE, mondayDemand, [employee], new Map(), 0, undefined, new Map(), new Map(), undefined, undefined, undefined, undefined, tuesdayDemand
      );
      expect(uncapped).toHaveLength(1);
      expect(isNightShift(uncapped[0].shiftCode, DATE)).toBe(true); // confirms the scenario really does force a night shift

      const caps = { maxConsecutiveWorkDays: 999, maxContinuousShiftHours: null, maxConsecutiveNightShifts: 0 };
      const exclusionsOut: HardCapExclusion[] = [];
      const capped = generateFlexiblePoolShifts(
        "Monday", DATE, mondayDemand, [employee], new Map(), 0, undefined, new Map(), new Map(), undefined, undefined, undefined,
        { caps, streakEnteringDay: new Map([["e1", 0]]), nightStreakEnteringDay: new Map([["e1", 0]]), exclusionsOut },
        tuesdayDemand
      );
      // The employee still covers Monday's own (ordinary, daytime) demand
      // with a non-night code -- the night cap excludes only the NIGHT
      // candidate, never the whole employee, exactly like
      // maxContinuousShiftHours above. Tuesday's early-morning demand
      // simply goes uncovered by this employee now (a genuine, honestly
      // reported gap elsewhere), which this unit call doesn't itself see.
      expect(capped).toHaveLength(1);
      expect(isNightShift(capped[0].shiftCode, DATE)).toBe(false);
      expect(exclusionsOut).toEqual([]); // a legal (daytime) alternative remained, so no whole-day exclusion is recorded
    });
  });
});
