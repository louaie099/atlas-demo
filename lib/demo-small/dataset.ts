import { Employee, Flight } from "../types";
import { buildConfigFromResolvedRules } from "../seed-data";
import { resolveDefaultLaborRules } from "../labor-rules";
import { buildUniformWeeklySchedule } from "../shift-templates";
import { flightDateFor, weekLabelFor } from "../flight-date";
import { generateSmallDemoFlights } from "./flights";
import {
  SMALL_DEMO_FLAT_RULE_EMPLOYEES,
  SMALL_DEMO_QATAR_AIRWAYS_EMPLOYEES,
  SMALL_DEMO_EMIRATES_EMPLOYEES,
  SMALL_DEMO_AIR_FRANCE_EMPLOYEES,
  SMALL_DEMO_FIXED_CYCLE_EMPLOYEES,
  SMALL_DEMO_ROTATING_EMPLOYEE,
} from "./employees";
import { buildFixedCycleWeeklySchedule } from "../fixed-cycle-rotation";

/**
 * SMALL DEMO DATASET — assembly.
 *
 * A separate, independent dataset for manual UI testing (Monthly Planning
 * + Live Operations). Originally sized for roughly 20-25 agents and 8-12
 * flights/day; grown twice since (2026-10-04, Moses) to ~48 agents across
 * 3 foreign carriers and larger RAM specialized teams — see
 * lib/demo-small/employees.ts and flights.ts for the full per-group/
 * per-flight sizing rationale and both rounds' reasoning. This module
 * never imports from
 * lib/seed-data.ts's EMPLOYEES/FLIGHTS constants, and nothing here is
 * read by lib/reset-database.ts or scripts/seed.ts — the main (large)
 * stress-test dataset is completely untouched by this file's existence.
 *
 * Reuses the exact same labor-rule resolution and Config assembly as
 * every other dataset (buildConfigFromResolvedRules — the one shared
 * assembly point lib/seed-data.ts documents) — the small demo runs under
 * the SAME confirmed rules (15h rest, 2 OFF days/week, hard consecutive-
 * work-day cap, etc.), never a relaxed or special-cased rule set invented
 * to make it easier to "succeed."
 */

const CONFIG_RULES = resolveDefaultLaborRules();
export const SMALL_DEMO_CONFIG = buildConfigFromResolvedRules(CONFIG_RULES);

export const SMALL_DEMO_DAYS_WITH_DATA = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/**
 * A week distinct from the main dataset's CURRENT_WEEK_START
 * (2026-08-31) so the two datasets' plans never collide on the same
 * WeeklyPlan id (planIdForWeek(weekStart)) if a database ever somehow held
 * rows from both at once. 2026-10-05 is a real Monday.
 */
export const SMALL_DEMO_WEEK_START = "2026-10-05";
export const SMALL_DEMO_WEEK_LABEL = weekLabelFor(SMALL_DEMO_WEEK_START);

export const SMALL_DEMO_FLIGHTS: Flight[] = generateSmallDemoFlights().map((f) => ({
  ...f,
  flight_date: flightDateFor(SMALL_DEMO_WEEK_START, f.day_of_week),
  week_start: SMALL_DEMO_WEEK_START,
}));

export const SMALL_DEMO_EMPLOYEES: Employee[] = [
  ...SMALL_DEMO_FLAT_RULE_EMPLOYEES.map((e) => ({
    ...e,
    weekly_shifts: buildUniformWeeklySchedule(e.shift_code, e.off_days, SMALL_DEMO_DAYS_WITH_DATA),
  })),
  ...SMALL_DEMO_QATAR_AIRWAYS_EMPLOYEES.map((e) => ({
    ...e,
    weekly_shifts: buildUniformWeeklySchedule(e.shift_code, e.off_days, SMALL_DEMO_DAYS_WITH_DATA),
  })),
  ...SMALL_DEMO_EMIRATES_EMPLOYEES.map((e) => ({
    ...e,
    weekly_shifts: buildUniformWeeklySchedule(e.shift_code, e.off_days, SMALL_DEMO_DAYS_WITH_DATA),
  })),
  ...SMALL_DEMO_AIR_FRANCE_EMPLOYEES.map((e) => ({
    ...e,
    weekly_shifts: buildUniformWeeklySchedule(e.shift_code, e.off_days, SMALL_DEMO_DAYS_WITH_DATA),
  })),
  ...SMALL_DEMO_FIXED_CYCLE_EMPLOYEES.map(({ employee, cycle, cycleOffset }) => ({
    ...employee,
    weekly_shifts: buildFixedCycleWeeklySchedule(cycle, cycleOffset, SMALL_DEMO_DAYS_WITH_DATA),
  })),
  {
    ...SMALL_DEMO_ROTATING_EMPLOYEE.employee,
    weekly_shifts: SMALL_DEMO_DAYS_WITH_DATA.map((day) => {
      const entry = SMALL_DEMO_ROTATING_EMPLOYEE.pattern.find((p) => p.day === day)!;
      return {
        day_of_week: day,
        shift_code: entry.code === "OFF" ? null : entry.code,
        status: (entry.code === "OFF" ? "off" : "working") as "off" | "working",
      };
    }),
  },
];
