import { Config } from "../types";

/**
 * Foundation for evaluating the confirmed 42h AVERAGE weekly working-hours
 * rule (lib/labor-rules.ts's maximumAverageWeeklyWorkingHours) against a
 * real reference period, once one is confirmed.
 *
 * Deliberately does NOT invent a period. `config.working_hours_reference_period_days`
 * is `null` until management confirms a real number (7, 14, 28, or
 * something else entirely) — until then, this returns an explicit
 * `not_evaluable` result rather than silently treating a single displayed
 * Monday-Sunday week as the reference period. A single week running high
 * or low is not, by itself, evidence of compliance or violation of an
 * AVERAGE rule computed over a longer (and currently unknown) window.
 *
 * Once a real period is confirmed, callers pass the actual total hours
 * worked over that period (`totalHoursOverPeriod`) and the number of days
 * that total actually covers (`periodDaysCovered` — may be less than the
 * confirmed reference period near the start of an employee's history, or
 * for a rotation that hasn't accumulated a full period yet); this
 * function does the division and comparison. It never re-derives "the
 * period" from a Monday-Sunday Employee.weekly_shifts snapshot itself —
 * that data source question belongs to the caller.
 *
 * NOT a target-hours obligation: this evaluates an upper CEILING
 * (maximum_average_weekly_working_hours), never a floor an employee must
 * be scheduled to reach. Whether/how much an employee should be rostered
 * to work at all is a separate, currently-unimplemented concept ("roster
 * planning" vs. the demand-driven "duty allocation" this pipeline
 * currently does) — see
 * docs/known-limitations/roster-planning-vs-duty-allocation.md. Do not
 * repurpose this ceiling as that floor when that work happens.
 */
export type AverageWorkingHoursResult =
  | {
      status: "not_evaluable";
      reason: "reference_period_unconfigured";
    }
  | {
      status: "compliant" | "violation";
      averageWeeklyHours: number;
      referencePeriodDays: number;
      totalHoursOverPeriod: number;
    };

export function evaluateAverageWorkingHours(
  totalHoursOverPeriod: number,
  periodDaysCovered: number,
  config: Config
): AverageWorkingHoursResult {
  if (config.working_hours_reference_period_days === null) {
    return { status: "not_evaluable", reason: "reference_period_unconfigured" };
  }
  if (periodDaysCovered <= 0) {
    return { status: "not_evaluable", reason: "reference_period_unconfigured" };
  }

  const averageWeeklyHours = (totalHoursOverPeriod / periodDaysCovered) * 7;
  const status = averageWeeklyHours > config.maximum_average_weekly_working_hours ? "violation" : "compliant";
  return {
    status,
    averageWeeklyHours: Math.round(averageWeeklyHours * 100) / 100,
    referencePeriodDays: config.working_hours_reference_period_days,
    totalHoursOverPeriod,
  };
}
