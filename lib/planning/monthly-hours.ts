import { SupabaseClient } from "@supabase/supabase-js";
import { WeeklyPlanRosterEntry } from "../types";
import { weeksOverlappingMonth, shiftMonth, flightDateFor } from "../flight-date";
import { BreakPolicy, DEFAULT_BREAK_POLICY } from "../break-policy";
import { computePaidHours } from "./paid-hours";
import { planIdForWeek, fetchAllRosterEntriesForPlan } from "./weekly-plan-service";

/**
 * MONTHLY PAID-HOUR AGGREGATION (Labor Rules v2, 2026-10-20).
 *
 * There is NO month-level persistence entity in this app (see
 * lib/planning/weekly-plan-service.ts's own doc comments) -- weekly_plans
 * and weekly_plan_roster_entries remain strictly isolated per ISO week
 * (tests/multi-week-isolation.test.ts). "Monthly Planning" is a UI
 * concept layered on top of that isolated weekly data via
 * lib/flight-date.ts's weeksOverlappingMonth -- this module follows the
 * exact same pattern: it reads ACROSS however many already-isolated
 * weekly_plans/weekly_plan_roster_entries rows overlap a calendar month,
 * entirely through the existing per-week fetch helpers
 * (fetchAllRosterEntriesForPlan), and never joins flights/requirements
 * across weeks -- the isolation bug the existing test guards against is
 * about THAT, not about a read-only aggregate computed from independently
 * fetched per-week data.
 *
 * Every shift occurrence's hours are attributed ENTIRELY to the calendar
 * day of its scheduled START (never split across the midnight an
 * overnight shift may cross, and never attributed to its end date) --
 * `flightDateFor(weekStart, day_of_week)` is exactly that start date,
 * already the authoritative source every other part of this app uses for
 * "what real calendar date is this roster entry on." A day is counted
 * toward `calendarDaysCovered` the moment a real roster entry exists for
 * it, whether the employee worked ("working", contributing real hours) or
 * not ("off", contributing zero) -- the distinction that matters for
 * coverage is "was this day actually planned," not "did they work it."
 *
 * This is intentionally a MONTH boundary, independent of
 * workingHoursReferencePeriodDays (the still-unconfirmed AVERAGE reference
 * period for maximumAverageWeeklyWorkingHours -- see lib/labor-rules.ts's
 * module doc comment) -- a genuinely different rule, never conflated with
 * this one.
 */
export type MonthlyHoursStatus = "evaluable" | "no_data" | "partial_coverage";

export interface MonthlyHoursResult {
  status: MonthlyHoursStatus;
  monthStart: string; // "YYYY-MM-DD", the 1st of the month this result covers
  calendarDaysInMonth: number;
  // A day counts as covered the moment ANY weekly_plan_roster_entries row
  // exists for this employee on that calendar date -- "working" or "off"
  // both count; only a day with NO row at all (no plan ever generated for
  // the week touching it, or the week's roster never reached this
  // employee) is uncovered.
  calendarDaysCovered: number;
  scheduledSpanTotal: number;
  paidHoursTotal: number;
  // true when ANY contributing day's paid-hours figure was computed under
  // an unconfirmed_prototype break policy -- see lib/break-policy.ts. A
  // caller must label paidHoursTotal accordingly, exactly like
  // lib/planning/paid-hours.ts's own PaidHoursResult.provisional.
  provisional: boolean;
}

function daysInCalendarMonth(monthStart: string): number {
  // shiftMonth(monthStart, 1) is the 1st of the NEXT month; the day count
  // between the two 1sts is exactly this month's length, including leap
  // Februaries, with no hand-maintained month-length table.
  const [y, m] = monthStart.split("-").map(Number);
  return new Date(y, m, 0).getDate(); // day 0 of next month = last day of this month
}

/** One week's already-fetched roster data, scoped the same way every other per-week read in this app is -- the pure computation below never fetches anything itself. */
export interface MonthlyHoursWeekInput {
  weekStart: string;
  /** false when no weekly_plans row exists at all for this week -- a genuine gap, distinct from a plan existing with this employee simply OFF every day. */
  planExists: boolean;
  entries: WeeklyPlanRosterEntry[];
}

/**
 * Pure aggregation — no Supabase access. Filters each week's entries down
 * to this one employee and to calendar dates that actually fall inside
 * `monthStart`'s month (a week overlapping the month boundary contributes
 * only its in-month days, never the days that spill into the adjacent
 * month — those are that OTHER month's own aggregation's job, and must
 * never be double-counted here or there).
 */
export function computeMonthlyHoursForEmployee(
  employeeId: string,
  monthStart: string,
  weeks: MonthlyHoursWeekInput[],
  breakPolicy: BreakPolicy = DEFAULT_BREAK_POLICY
): MonthlyHoursResult {
  const calendarDaysInMonth = daysInCalendarMonth(monthStart);
  const monthEndExclusive = shiftMonth(monthStart, 1); // first day of the FOLLOWING month

  let calendarDaysCovered = 0;
  let scheduledSpanTotal = 0;
  let paidHoursTotal = 0;
  let provisional = breakPolicy.source === "unconfirmed_prototype";

  for (const week of weeks) {
    if (!week.planExists) continue; // a genuine gap -- contributes no covered days, never an assumed zero
    for (const entry of week.entries) {
      if (entry.employee_id !== employeeId) continue;
      const date = flightDateFor(week.weekStart, entry.day_of_week);
      if (date < monthStart || date >= monthEndExclusive) continue; // belongs to an adjacent month's own aggregation
      calendarDaysCovered += 1;
      if (entry.status === "off" || !entry.shift_code) continue; // a real, covered OFF day -- contributes zero hours, not a gap
      const result = computePaidHours(entry.shift_code, date, breakPolicy);
      scheduledSpanTotal += result.scheduledSpanHours;
      paidHoursTotal += result.paidHours;
    }
  }

  const status: MonthlyHoursStatus =
    calendarDaysCovered === 0 ? "no_data" : calendarDaysCovered < calendarDaysInMonth ? "partial_coverage" : "evaluable";

  return {
    status,
    monthStart,
    calendarDaysInMonth,
    calendarDaysCovered,
    scheduledSpanTotal: Math.round(scheduledSpanTotal * 100) / 100,
    paidHoursTotal: Math.round(paidHoursTotal * 100) / 100,
    provisional,
  };
}

/**
 * Fetches every week overlapping `monthStart`'s calendar month (via
 * lib/flight-date.ts's weeksOverlappingMonth) and delegates to the pure
 * computation above. Each week is fetched independently through the
 * existing, already-isolated per-plan helpers -- never a cross-week query.
 * A week with no weekly_plans row at all is reported as `planExists:
 * false` rather than throwing -- a genuinely unplanned week is exactly the
 * `partial_coverage` case this result type exists to represent honestly,
 * not an error.
 */
export async function loadMonthlyHoursForEmployee(
  supabase: SupabaseClient,
  employeeId: string,
  monthStart: string,
  breakPolicy: BreakPolicy = DEFAULT_BREAK_POLICY
): Promise<MonthlyHoursResult> {
  const weekStarts = weeksOverlappingMonth(monthStart);
  const weeks: MonthlyHoursWeekInput[] = await Promise.all(
    weekStarts.map(async (weekStart): Promise<MonthlyHoursWeekInput> => {
      const planId = planIdForWeek(weekStart);
      const { data: planRows, error: planErr } = await supabase.from("weekly_plans").select("id").eq("id", planId);
      if (planErr) throw new Error(`Loading monthly hours failed (week ${weekStart}): ${planErr.message}`);
      const planExists = (planRows ?? []).length > 0;
      const entries = planExists ? await fetchAllRosterEntriesForPlan(supabase, planId) : [];
      return { weekStart, planExists, entries };
    })
  );
  return computeMonthlyHoursForEmployee(employeeId, monthStart, weeks, breakPolicy);
}
