import { weekLabelFor } from "../flight-date";

/**
 * The PoC demo dataset's own week — a Monday distinct from BOTH other
 * datasets' own week starts (main: 2026-08-31, small demo: 2026-10-05) so
 * no two datasets' WeeklyPlan ids (planIdForWeek(weekStart)) can ever
 * collide if a database somehow held rows from more than one at once.
 * 2026-10-19 is a real Monday, the week after the small demo's own week.
 *
 * Kept in its own module (not lib/demo-poc/employees.ts or flights.ts) so
 * both of those can be written and reasoned about independently without a
 * circular import between them.
 */
export const POC_DEMO_WEEK_START = "2026-10-19";
export const POC_DEMO_WEEK_LABEL = weekLabelFor(POC_DEMO_WEEK_START);
