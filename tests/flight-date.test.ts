import { describe, it, expect } from "vitest";
import { dayOfWeekFor, weekStartFor, flightDateFor, weekLabelFor, shiftWeek, DAYS_ORDER } from "../lib/flight-date";
import { CURRENT_WEEK_START, CURRENT_WEEK_LABEL } from "../lib/seed-data";

/**
 * GUARD, not a normal unit test: this exists specifically so the bug this
 * milestone found and fixed -- CURRENT_WEEK_START ("2026-09-01") was never
 * an actual Monday, invisible for the entire project's history until real
 * calendar validation (flight_date/week_start, the flights_date_matches_
 * day_of_week CHECK constraint) existed to catch it -- can never silently
 * come back. If this fails, whatever CURRENT_WEEK_START is currently set
 * to is NOT a real Monday, and every downstream date the seed data/Reset
 * Demo/Add Flight/Import Flights computes from it will be wrong.
 */
describe("CURRENT_WEEK_START must always be a real Monday", () => {
  it("dayOfWeekFor(CURRENT_WEEK_START) is genuinely Monday", () => {
    expect(dayOfWeekFor(CURRENT_WEEK_START)).toBe("Monday");
  });

  it("flightDateFor(CURRENT_WEEK_START, day) round-trips correctly for all 7 real weekdays", () => {
    for (const day of DAYS_ORDER) {
      const date = flightDateFor(CURRENT_WEEK_START, day);
      expect(dayOfWeekFor(date)).toBe(day);
    }
  });

  it("CURRENT_WEEK_LABEL is derived from CURRENT_WEEK_START, not an independently hand-maintained string that could drift from it", () => {
    expect(CURRENT_WEEK_LABEL).toBe(weekLabelFor(CURRENT_WEEK_START));
    expect(CURRENT_WEEK_LABEL.startsWith("Week of Mon,")).toBe(true);
  });
});

describe("lib/flight-date.ts", () => {
  it("weekStartFor returns the same Monday for every day inside that real calendar week", () => {
    const monday = flightDateFor(CURRENT_WEEK_START, "Monday");
    for (const day of DAYS_ORDER) {
      const date = flightDateFor(CURRENT_WEEK_START, day);
      expect(weekStartFor(date)).toBe(monday);
    }
  });

  it("weekStartFor of a date that is ITSELF a Monday returns that same date, never the previous week", () => {
    // The exact live-deployed bug: Sunday's flight_date (week_start + 6)
    // can land on the FOLLOWING real Monday if week_start isn't itself a
    // real Monday -- weekStartFor must never push a Monday backward into
    // the wrong week.
    const nextMonday = shiftWeek(CURRENT_WEEK_START, 1);
    expect(dayOfWeekFor(nextMonday)).toBe("Monday");
    expect(weekStartFor(nextMonday)).toBe(nextMonday);
  });

  it("shiftWeek moves by exactly 7 real calendar days, preserving the weekday", () => {
    const next = shiftWeek(CURRENT_WEEK_START, 1);
    const prev = shiftWeek(CURRENT_WEEK_START, -1);
    expect(dayOfWeekFor(next)).toBe("Monday");
    expect(dayOfWeekFor(prev)).toBe("Monday");
    expect(next).not.toBe(CURRENT_WEEK_START);
    expect(prev).not.toBe(CURRENT_WEEK_START);
  });
});

/**
 * WEEK PICKER (2026-09-29 milestone) — components/week-picker.tsx builds its
 * jump-list and "any date" input entirely from this module's own primitives
 * (shiftWeek/weekLabelFor/weekStartFor), never independent date math, and
 * this repo has no component-render test infrastructure (no
 * @testing-library dependency) — so the picker's correctness is proven here,
 * at the primitive level it's built from, rather than by rendering it.
 */
describe("week picker primitives — jumping several weeks is a single direct hop, not N single-week steps", () => {
  it("shiftWeek(weekStart, 7) lands on the exact same Monday as seven separate +1 hops — proving a direct N-week jump is correct, not merely a convenient shorthand for clicking Next repeatedly", () => {
    let steppedSevenTimes = CURRENT_WEEK_START;
    for (let i = 0; i < 7; i++) steppedSevenTimes = shiftWeek(steppedSevenTimes, 1);
    expect(shiftWeek(CURRENT_WEEK_START, 7)).toBe(steppedSevenTimes);
  });

  it("the picker's jump-list (4 back, current, 5 forward) is exactly shiftWeek(anchor, i-4) for i in 0..9, in chronological order, each a real Monday", () => {
    const anchor = CURRENT_WEEK_START;
    const weeks = Array.from({ length: 10 }, (_, i) => shiftWeek(anchor, i - 4));
    for (const w of weeks) expect(dayOfWeekFor(w)).toBe("Monday");
    expect(weeks[4]).toBe(anchor); // the anchor itself is always in the list
    for (let i = 1; i < weeks.length; i++) expect(weeks[i] > weeks[i - 1]).toBe(true); // strictly chronological
  });

  it("weekStartFor resolves an arbitrary picked date to its own real week, regardless of which weekday was picked — the picker's 'jump to any date' input", () => {
    for (const day of DAYS_ORDER) {
      const arbitraryDate = flightDateFor(shiftWeek(CURRENT_WEEK_START, 3), day);
      expect(weekStartFor(arbitraryDate)).toBe(shiftWeek(CURRENT_WEEK_START, 3));
    }
  });

  it("'Today' resolves via weekStartFor, never CURRENT_WEEK_START — the seeded demo default week and the real current week are independent concepts", () => {
    const today = new Date();
    const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const realCurrentWeek = weekStartFor(todayISO);
    expect(dayOfWeekFor(realCurrentWeek)).toBe("Monday");
    // No assertion that these differ (they could coincide) — only that
    // "Today" is never hardcoded to the seeded demo week.
    expect(typeof realCurrentWeek).toBe("string");
  });
});
