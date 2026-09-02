import { Flight } from "./types";
import { SHIFT_CODES } from "./shift-templates";
import { computeForeignCompanyProtectedWindow } from "./foreign-company-window";

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTime(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

/**
 * Selects the RAM Handling shift code that covers a given protected
 * window, from the authoritative shift catalog — never a hardcoded
 * per-company mapping. A shift is compatible only if it starts at or
 * before the window start AND ends at or after the window end (i.e. the
 * shift fully contains the company's operational window).
 *
 * Among compatible shifts, prefers (1) the smallest gap between shift
 * start and window start (closest fit, least wasted early time), then
 * (2) the shortest total shift duration (don't roster someone longer than
 * necessary). This is what makes "Gulf Air at 09:00 → MT02" fall out of
 * the general rule rather than being a special case for Gulf Air.
 *
 * Deliberately does not handle shifts or windows that cross midnight —
 * a documented limitation for overnight company flights, not silently
 * guessed. Returns null (never a fabricated shift) if no catalog code is
 * compatible.
 */
export function selectCompatibleShiftCode(windowStart: string, windowEnd: string): string | null {
  const windowStartMin = timeToMinutes(windowStart);
  const windowEndMin = timeToMinutes(windowEnd);

  const candidates = Object.entries(SHIFT_CODES)
    .map(([code, { entree, sortie }]) => ({
      code,
      entreeMin: timeToMinutes(entree),
      sortieMin: timeToMinutes(sortie),
    }))
    .filter((c) => c.sortieMin > c.entreeMin) // exclude overnight-wrapping codes from this matcher
    .filter((c) => c.entreeMin <= windowStartMin && c.sortieMin >= windowEndMin);

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const gapA = windowStartMin - a.entreeMin;
    const gapB = windowStartMin - b.entreeMin;
    if (gapA !== gapB) return gapA - gapB;
    const durationA = a.sortieMin - a.entreeMin;
    const durationB = b.sortieMin - b.entreeMin;
    return durationA - durationB;
  });

  return candidates[0].code;
}

/**
 * Finds EVERY flight a given company operates on a given day — never
 * assumes at most one. Returns an empty array (never a fabricated flight)
 * if that company has no flight that day.
 */
export function findCompanyFlightsOnDay(company: string, dayOfWeek: string, flights: Flight[]): Flight[] {
  return flights.filter((f) => f.airline === company && f.day_of_week === dayOfWeek);
}

export interface FlightWindow {
  flight: Flight;
  window: { start: string; end: string };
}

export interface ForeignDayPlan {
  flights: Flight[]; // every company flight that day (always >= 1 when this is non-null)
  windows: FlightWindow[]; // each flight's own individual protected window
  combinedWindow: { start: string; end: string }; // union span, used only for shift selection
  shiftCode: string | null;
}

/**
 * The core rule this module exists for: company flight schedule drives
 * the roster, not the other way around. Given a company and a day, if
 * that company has one or more flights that day, this computes each
 * flight's own protected window (kept separate, for precise per-flight
 * overlap checks elsewhere), the combined span across all of them (used
 * only to pick one RAM shift that covers the whole day's company
 * operation), and the compatible shift for that combined span.
 *
 * Returns null — never a fake plan — if there's no flight that day.
 */
export function planForeignCompanyDay(company: string, dayOfWeek: string, flights: Flight[]): ForeignDayPlan | null {
  const dayFlights = findCompanyFlightsOnDay(company, dayOfWeek, flights);
  if (dayFlights.length === 0) return null;

  const windows: FlightWindow[] = dayFlights.map((flight) => ({
    flight,
    window: computeForeignCompanyProtectedWindow(flight),
  }));

  const combinedStartMin = Math.min(...windows.map((w) => timeToMinutes(w.window.start)));
  const combinedEndMin = Math.max(...windows.map((w) => timeToMinutes(w.window.end)));
  const combinedWindow = { start: minutesToTime(combinedStartMin), end: minutesToTime(combinedEndMin) };

  const shiftCode = selectCompatibleShiftCode(combinedWindow.start, combinedWindow.end);

  return { flights: dayFlights, windows, combinedWindow, shiftCode };
}
