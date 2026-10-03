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

/**
 * Today's real calendar date, "YYYY-MM-DD", in the server's local
 * timezone — deliberately NOT `new Date().toISOString().slice(0, 10)`,
 * which reports UTC and can silently roll to the wrong calendar day in a
 * negative-UTC-offset timezone. Matches the existing local-date pattern
 * already used by components/week-picker.tsx's own `todayISO`, centralized
 * here so every "what is today" caller (Live Operations' default date
 * included) shares one implementation.
 */
export function todayISO(): string {
  return formatISODate(new Date());
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

// MONTHLY PLANNING (2026-10-03): the month is the planning HORIZON, the
// week stays the inspection/working view underneath it (see the product
// doc comment on app/planning/page.tsx) — these are pure, additive
// calendar helpers, built the same way every other function in this file
// is (plain local-date arithmetic, no new parsing convention), so a month
// view can be composed as a thin layer above the existing week-scoped
// plumbing (WeekNav/WeekPicker/loadWeeklyPlan) without changing any of it.
// Nothing below here is itself a unit of planning work — weekStart remains
// that, exactly as before; a monthStart is only ever used to derive which
// weeks to show.

/** The first day ("YYYY-MM-DD") of the calendar month containing this date. */
export function monthStartFor(date: string): string {
  const d = parseISODate(date);
  return formatISODate(new Date(d.getFullYear(), d.getMonth(), 1));
}

/** monthStart shifted by a number of whole calendar months (negative for previous months) — native Date rollover handles year boundaries (Dec -> Jan) with no special-casing. */
export function shiftMonth(monthStart: string, months: number): string {
  const d = parseISODate(monthStart);
  return formatISODate(new Date(d.getFullYear(), d.getMonth() + months, 1));
}

/** A human display label for a month, e.g. "October 2026". */
export function monthLabelFor(monthStart: string): string {
  const d = parseISODate(monthStart);
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/**
 * Every display week's Monday ("YYYY-MM-DD") that OVERLAPS the given
 * calendar month, in order — a week that starts in the prior month but
 * runs into this one (or starts in this month but runs into the next) is
 * included, exactly once, keyed by its own Monday. This is a pure
 * composition of weekStartFor/shiftWeek — no new date-math primitive —
 * and is the one thing this app didn't have a month concept for before:
 * "which weeks does this month touch."
 */
export function weeksOverlappingMonth(monthStart: string): string[] {
  const start = parseISODate(monthStart);
  const monthIndex = start.getMonth();
  const monthYear = start.getFullYear();
  const lastDayOfMonth = formatISODate(new Date(monthYear, monthIndex + 1, 0));

  const weeks: string[] = [];
  let w = weekStartFor(monthStart);
  while (parseISODate(w) <= parseISODate(lastDayOfMonth)) {
    weeks.push(w);
    w = shiftWeek(w, 1);
  }
  return weeks;
}

/** A short "Oct 1 – Nov 1" style range label for one week's Monday-Sunday span, used to label a week sub-tab inside a month view without repeating the full weekLabelFor sentence. */
export function weekRangeLabelFor(weekStart: string): string {
  const dates = weekDates(weekStart);
  const start = parseISODate(dates[0]);
  const end = parseISODate(dates[6]);
  const fmt = (d: Date, withYear: boolean) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: withYear ? "numeric" : undefined });
  const sameYear = start.getFullYear() === end.getFullYear();
  return `${fmt(start, !sameYear)} – ${fmt(end, true)}`;
}
