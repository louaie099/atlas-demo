import { Employee, Flight } from "../types";
import { buildConfigFromResolvedRules } from "../seed-data";
import { resolveDefaultLaborRules } from "../labor-rules";
import { buildUniformWeeklySchedule } from "../shift-templates";
import { flightDateFor } from "../flight-date";
import { generatePocDemoFlights } from "./flights";
import { POC_DEMO_FLAT_RULE_EMPLOYEES, POC_DEMO_QATAR_AIRWAYS_EMPLOYEES } from "./employees";
import { POC_DEMO_WEEK_START, POC_DEMO_WEEK_LABEL } from "./week";

/**
 * POC DEMO DATASET — assembly (docs/ATLAS_POC_PLAN.md Section 5). A THIRD,
 * independent dataset sized for a short live management demonstration —
 * see lib/demo-poc/flights.ts and employees.ts for the full per-flight/
 * per-group sizing rationale. Never imports from lib/seed-data.ts's own
 * EMPLOYEES/FLIGHTS constants or lib/demo-small/dataset.ts, and nothing
 * here is read by lib/reset-database.ts, lib/reset-small-demo.ts, or
 * scripts/seed.ts — neither other dataset is touched by this file's
 * existence.
 *
 * Reuses the exact same labor-rule resolution and Config assembly as
 * every other dataset (buildConfigFromResolvedRules) — the PoC demo runs
 * under the SAME confirmed rules, never a relaxed or special-cased rule
 * set invented to make the demo "succeed."
 */

const CONFIG_RULES = resolveDefaultLaborRules();
export const POC_DEMO_CONFIG = buildConfigFromResolvedRules(CONFIG_RULES);

export const POC_DEMO_DAYS_WITH_DATA = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export { POC_DEMO_WEEK_START, POC_DEMO_WEEK_LABEL };

export const POC_DEMO_FLIGHTS: Flight[] = generatePocDemoFlights().map((f: Omit<Flight, "flight_date" | "week_start">) => ({
  ...f,
  flight_date: flightDateFor(POC_DEMO_WEEK_START, f.day_of_week),
  week_start: POC_DEMO_WEEK_START,
}));

export const POC_DEMO_EMPLOYEES: Employee[] = [
  ...POC_DEMO_FLAT_RULE_EMPLOYEES.map((e) => ({
    ...e,
    weekly_shifts: buildUniformWeeklySchedule(e.shift_code, e.off_days, POC_DEMO_DAYS_WITH_DATA),
  })),
  ...POC_DEMO_QATAR_AIRWAYS_EMPLOYEES.map((e) => ({
    ...e,
    weekly_shifts: buildUniformWeeklySchedule(e.shift_code, e.off_days, POC_DEMO_DAYS_WITH_DATA),
  })),
];
