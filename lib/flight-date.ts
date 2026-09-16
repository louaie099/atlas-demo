/**
 * Single source of truth for flight-date/week-scoping math — every place
 * that needs to go between a calendar date, its weekday label, and its
 * display week's Monday uses THIS module, never its own ad-hoc
 * computation. flight_date is the real, authoritative chronological
 * value (see the Flight type's own doc comment) — day_of_week and
 * week_start are both derived FROM it, one direction only, so they can
 * never silently drift apart from the date they're supposed to describe.
 */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

function parseISODate(iso: string): Date {
  // Deliberately NOT `new Date(iso)` -- that parses as UTC midnight and
  // then reports back a DIFFERENT calendar date in a negative-UTC-offset
  // local timezone. Every date this app handles is a plain calendar date
  // ("YYYY-MM-DD"), never a timestamp, so parsing and formatting must
  // stay entirely in this format's own local-agnostic arithmetic.
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatISODate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The weekday name ("Monday", "Tuesday", ...) for a "YYYY-MM-DD" date, derived — never independently stated. */
export function dayOfWeekFor(flightDate: string): string {
  return DAY_NAMES[parseISODate(flightDate).getDay()];
}

/** The Monday ("YYYY-MM-DD") of the display week containing this date. */
export function weekStartFor(flightDate: string): string {
  const date = parseISODate(flightDate);
  const isoDayIndex = (date.getDay() + 6) % 7; // Monday=0 .. Sunday=6
  date.setDate(date.getDate() - isoDayIndex);
  return formatISODate(date);
}

/** A given week's Monday-Sunday, as "YYYY-MM-DD" dates in order. */
export function weekDates(weekStart: string): string[] {
  const start = parseISODate(weekStart);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return formatISODate(d);
  });
}

/** flight_date for a given week_start + weekday label — the inverse of dayOfWeekFor/weekStartFor, used only where a day LABEL is the known input (e.g. the existing seed generators, which still build flights day-by-day). */
export function flightDateFor(weekStart: string, dayOfWeek: string): string {
  const offset = DAYS_ORDER.indexOf(dayOfWeek);
  if (offset === -1) throw new Error(`Unknown day_of_week: ${dayOfWeek}`);
  const start = parseISODate(weekStart);
  start.setDate(start.getDate() + offset);
  return formatISODate(start);
}

export const DAYS_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** weekStart shifted by a number of whole weeks (negative for previous weeks). */
export function shiftWeek(weekStart: string, weeks: number): string {
  const start = parseISODate(weekStart);
  start.setDate(start.getDate() + weeks * 7);
  return formatISODate(start);
}

/** A short, human display label, e.g. "Week of Mon, Sep 1 2026" — matches the existing CURRENT_WEEK_LABEL format exactly, computed instead of hand-maintained per week. */
export function weekLabelFor(weekStart: string): string {
  const date = parseISODate(weekStart);
  const weekday = DAY_NAMES[date.getDay()].slice(0, 3);
  const month = date.toLocaleDateString("en-US", { month: "short" });
  return `Week of ${weekday}, ${month} ${date.getDate()} ${date.getFullYear()}`;
}
