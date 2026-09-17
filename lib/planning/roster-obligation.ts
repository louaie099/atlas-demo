import { Config } from "../types";

/**
 * Foundation for evaluating the working-hours OBLIGATION (a target/floor
 * an employee should be scheduled to work) once one is confirmed — see
 * lib/labor-rules.ts's workingHoursObligationHours and
 * docs/known-limitations/roster-planning-vs-duty-allocation.md.
 *
 * This is deliberately the mirror image of lib/planning/average-hours.ts,
 * not a duplicate of it: average-hours.ts evaluates a confirmed CEILING
 * (maximum_average_weekly_working_hours, 42h) that an employee's real
 * hours must never exceed; this module evaluates a currently UNCONFIRMED
 * FLOOR/TARGET (working_hours_obligation_hours) that roster generation
 * should schedule an employee TO REACH, independent of whether flight
 * demand alone would justify that many hours. Confusing the two — e.g.
 * treating 42h as if it were also the target — would silently invent a
 * business rule nobody confirmed; see the doc comments on both config
 * fields for why they must stay separate values.
 *
 * Deliberately does NOT invent a target or a reference period.
 * `config.working_hours_obligation_hours` is `null` until RAM Handling
 * confirms a real number (and, once confirmed, that number's own real
 * meaning still needs a reference period the same way the 42h ceiling
 * does — a flat weekly figure and an averaged figure are not
 * interchangeable). Until then, this returns an explicit
 * `not_evaluable` result — no caller may treat null as "assume the 42h
 * ceiling," "assume a 5-day week," or any other default.
 *
 * NOT YET WIRED into any generation stage. This module exists so a
 * future roster-generation stage has a real, honest place to read a
 * confirmed obligation from, without that stage (or this one) guessing
 * the number in the meantime.
 */
export type RosterObligationResult =
  | {
      status: "not_evaluable";
      reason: "obligation_unconfirmed";
    }
  | {
      status: "met" | "short";
      scheduledHours: number;
      obligationHours: number;
      shortfallHours: number;
    };

export function evaluateRosterObligation(scheduledHoursThisPeriod: number, config: Config): RosterObligationResult {
  if (config.working_hours_obligation_hours === null) {
    return { status: "not_evaluable", reason: "obligation_unconfirmed" };
  }

  const obligationHours = config.working_hours_obligation_hours;
  const shortfallHours = Math.max(0, Math.round((obligationHours - scheduledHoursThisPeriod) * 100) / 100);
  return {
    status: shortfallHours > 0 ? "short" : "met",
    scheduledHours: scheduledHoursThisPeriod,
    obligationHours,
    shortfallHours,
  };
}
