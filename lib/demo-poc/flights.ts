import { Flight } from "../types";
import { classifyDestinationOperationally } from "../destination-classification";

/**
 * POC DEMO DATASET — flight side.
 *
 * Purpose (2026-10-13, M1 of the approved PoC plan — see
 * docs/ATLAS_POC_PLAN.md Section 5): a THIRD, independent, much smaller
 * dataset sized for a 5-7 minute live management demonstration, not for
 * stress-testing (lib/seed-data.ts) or manual UI exploration
 * (lib/demo-small/dataset.ts — 48 employees). This module does not
 * replace, import from, or modify either of those datasets in any way,
 * and neither of them is touched by this one's existence. Also entirely
 * separate from the real October operational schedule (636 flights) —
 * nothing here reads from or feeds that schedule, and nothing there reads
 * from this synthetic one.
 *
 * "5 flights" below means 5 distinct flight PROGRAMS (flight numbers),
 * not 5 scheduled rows — exactly like SMALL_DEMO_FLIGHT_TEMPLATES counts
 * itself the same way. Scheduled across the week as noted per flight,
 * this produces 31 total flight-instances over the 7 days (see the
 * per-flight comments below for the day pattern and why).
 *
 * Deliberately real, not manufactured: every flight here uses the exact
 * same classification/company-config machinery the main and small
 * datasets use (classifyDestinationOperationally,
 * lib/ram-staffing-matrix.ts's universal Gate/Boarding rule and
 * destination-gated Profiling rule, lib/company-config.ts's real Qatar
 * Airways headcount). Nothing about staffing LOGIC is reimplemented
 * here; only the flight schedule is small and chosen to reliably exercise
 * all four PoC demonstration scenarios (docs/ATLAS_POC_PLAN.md Section 6)
 * against a correspondingly small, named roster (lib/demo-poc/employees.ts).
 *
 * 2026-10-21 (schedule-realism fix — flights resized to fit the 17-agent
 * workforce, not the other way around): previously every flight number
 * departed at the exact same clock time all seven days — unrealistic, and
 * also what forced AT502's Profiling demand into a permanent, headcount-
 * forced baseline gap (the 17-agent headcount fix had closed that by
 * ADDING Profiling headcount; this pass instead keeps that 17-agent
 * roster fixed and varies the SCHEDULE). Each RAM flight's departure now
 * varies by day of week (departureByDay, see below) — a realistic
 * weekday/weekend shape — while staying within the SAME per-instance
 * headcount this dataset always had (1 Gate + 1 Boarding + 1 Profiling-
 * where-applicable per instance; the total weekly requirement count is
 * unchanged, 55 person-slots across 52 rows, still zero-gap-coverable by
 * the same 17 people — re-verified by the real engine, not assumed; see
 * tests/poc-demo-dataset.test.ts's criterion 1 test). Two instances stay
 * PINNED at their original time because the two live-disruption scenarios
 * target them specifically: AT503/Wednesday (Scenario B/C) and AT502/
 * Tuesday (Scenario D) — see each flight's own doc comment below for
 * exactly why. AT502's Saturday departure was deliberately chosen so its
 * requirement window genuinely OVERLAPS AT501's own Saturday window —
 * two concurrent Gate/Boarding demands the same morning, resolved by two
 * different on-roster employees (confirmed via the real engine, not
 * assumed) — a real instance of "overlapping flights, different staffing
 * demand" instead of every flight politely taking its own turn all week.
 *
 *  - AT501 (CMN->RAK, Domestic, daily) and AT503 (CMN->FEZ, Domestic,
 *    daily) are the two ordinary RAM core flights — universal Gate +
 *    Boarding demand, standard 737. AT503's Wednesday departure is the
 *    flight live-delayed during Scenario B/C (see that module's own
 *    verification notes in tests/poc-demo-dataset.test.ts for exactly why
 *    Wednesday and exactly why this delay amount).
 *  - AT502 (CMN->ORY, Europe/Schengen -> triggers the universal
 *    Gate/Boarding rule PLUS the real Profiling rule, 1 agent/flight,
 *    standard aircraft) runs DAILY. With 3 Profiling-qualified employees
 *    now on the roster (lib/demo-poc/employees.ts), the baseline is
 *    genuinely zero-gap across all 7 days (re-verified by the real
 *    engine) — the "honest failure" demonstration no longer lives in the
 *    starting state at all; it's a LIVE disruption instead (Scenario D,
 *    targeting Tuesday specifically, the one day only a single Profiling-
 *    qualified person ends up rostered).
 *  - QR601 (CMN->DOH, Qatar Airways, self-managed, Mon/Wed/Fri) is the
 *    one foreign-company flight — real company_config headcount (2
 *    agents/flight, lib/company-config.ts), rostered against a real
 *    Rotation Feasibility Engine-derived team (employees.ts).
 *  - TK601 (CMN->IST, Turkish Airlines, self-managed, daily) is the
 *    deliberately UNCONFIGURED carrier — real schedule noise with zero
 *    staffing cost, same honest "unmanaged" path as both other datasets'
 *    own Turkish Airlines flight. Costs nothing in headcount; included
 *    purely so the demo also shows a flight ATLAS correctly does NOT
 *    attempt to staff.
 */

const ALL_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MON_WED_FRI = ["Monday", "Wednesday", "Friday"];

interface PocFlightTemplate {
  flightNumber: string;
  airline: string;
  origin: string;
  destination: string;
  aircraft: string;
  /**
   * Departure time per day of week (one entry required for every day in
   * daysOfWeek). A 2026-10-21 (PoC schedule-realism fix) change from a
   * single fixed clock time: a real airline's own schedule varies by day
   * (weekday vs weekend banks) rather than the exact same flight number
   * departing at the exact same minute seven days running — see this
   * file's module comment for the full per-flight rationale, including
   * which two instances are pinned (AT503/Wednesday, AT502/Tuesday) and
   * why.
   */
  departureByDay: Record<string, string>;
  operatorType: "atlas_managed" | "self_managed";
  daysOfWeek: string[];
  bookingPressure: "normal" | "elevated";
}

const SYNTHETIC_DEMO_AIRCRAFT_CAPACITY: Record<string, number> = {
  "Boeing 737-800": 189,
  "Airbus A321": 220,
};

function getSyntheticSeatCapacity(aircraft: string): number | null {
  return SYNTHETIC_DEMO_AIRCRAFT_CAPACITY[aircraft] ?? null;
}

function stableHash(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function syntheticBookedPassengersFor(flightInstanceKey: string, capacity: number | null): number | null {
  if (capacity === null) return null;
  const spread = stableHash(flightInstanceKey) % 1000;
  const loadFactor = 0.72 + (spread / 999) * (0.88 - 0.72);
  return Math.min(Math.max(Math.round(capacity * loadFactor), 0), capacity);
}

/**
 * Flight numbers deliberately avoid both other datasets' own protected/
 * generated sets (lib/flight-generator.ts's AT100/201/302/401/535/650/
 * 740/803/870/EK751/AF1234, and lib/demo-small/flights.ts's AT120/160/
 * 225/310/420/560/660/815/QR1015/AF1680/EK702/TK653) so all three
 * datasets' flights stay visually distinguishable if ever shown together.
 */
function uniformTimes(time: string, days: string[]): Record<string, string> {
  return Object.fromEntries(days.map((d) => [d, time]));
}

/**
 * AT501 (CMN->RAK, domestic): an early-morning weekday departure, a later
 * weekend one — the ordinary "weekday commuter bank vs. weekend leisure
 * bank" shape a real domestic schedule has. Every time stays within the
 * General T1 Pool's real early-shift codes' actual window (MT01/MT03
 * entree 05:45) so the requirement window (60-minute lead) is always
 * coverable by at least one on-roster Gate-qualified employee.
 */
const AT501_TIMES: Record<string, string> = {
  Monday: "06:45",
  Tuesday: "06:45",
  Wednesday: "06:45",
  Thursday: "06:45",
  Friday: "06:45",
  Saturday: "09:15",
  Sunday: "09:15",
};

/**
 * AT503 (CMN->FEZ, domestic): kept at a uniform 14:00 every day —
 * deliberately NOT varied like AT501/AT502. Wednesday's instance is the
 * exact flight Scenario B/C's live delay targets (see
 * tests/poc-demo-dataset.test.ts); empirically, the General T1 Pool's
 * own demand-aware shift water-filling (lib/planning/shift-generation.ts
 * Stage 6) turned out to be sensitive to schedule changes on OTHER days
 * of the week too (confirmed by direct testing, not assumed — varying
 * AT501/AT502 alone measurably changed which employee Stage 6 put on
 * Wednesday and with which shift code), so AT503 is left untouched to
 * keep that one scenario's mechanics as stable and predictable as
 * possible while the rest of the week gets its variety.
 */
const AT503_TIMES: Record<string, string> = uniformTimes("14:00", ALL_DAYS);

/**
 * AT502 (CMN->ORY, Europe/Schengen -> Profiling): Tuesday is PINNED at
 * 11:30 — the exact instance Scenario D's live delay targets, unchanged
 * from the original design. Every other day varies (still well inside
 * the Profiling team's single NR02 shift code's 08:00-18:15 coverage
 * band, so Profiling coverage is unaffected by the exact minute).
 * Saturday (09:00) is deliberately chosen so its 08:00-09:00 requirement
 * window genuinely OVERLAPS AT501's own Saturday 08:15-09:15 window —
 * two concurrent Gate/Boarding demands on the same morning, a real
 * instance of "overlapping flights, different staffing demand" rather
 * than every flight politely taking its own turn all week.
 */
const AT502_TIMES: Record<string, string> = {
  Monday: "10:45",
  Tuesday: "11:30",
  Wednesday: "10:45",
  Thursday: "10:45",
  Friday: "10:45",
  Saturday: "09:00",
  Sunday: "09:45",
};

export const POC_DEMO_FLIGHT_TEMPLATES: PocFlightTemplate[] = [
  { flightNumber: "AT501", airline: "Royal Air Maroc", origin: "CMN", destination: "RAK", aircraft: "Boeing 737-800", departureByDay: AT501_TIMES, operatorType: "atlas_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  { flightNumber: "AT503", airline: "Royal Air Maroc", origin: "CMN", destination: "FEZ", aircraft: "Boeing 737-800", departureByDay: AT503_TIMES, operatorType: "atlas_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  { flightNumber: "AT502", airline: "Royal Air Maroc", origin: "CMN", destination: "ORY", aircraft: "Boeing 737-800", departureByDay: AT502_TIMES, operatorType: "atlas_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  { flightNumber: "QR601", airline: "Qatar Airways", origin: "CMN", destination: "DOH", aircraft: "Airbus A321", departureByDay: uniformTimes("18:30", MON_WED_FRI), operatorType: "self_managed", daysOfWeek: MON_WED_FRI, bookingPressure: "normal" },
  { flightNumber: "TK601", airline: "Turkish Airlines", origin: "CMN", destination: "IST", aircraft: "Airbus A321", departureByDay: uniformTimes("20:15", ALL_DAYS), operatorType: "self_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
];

/** Same generation shape as the other two datasets' own generators — flight_date/week_start are attached by the caller (dataset.ts). */
export function generatePocDemoFlights(): Omit<Flight, "flight_date" | "week_start">[] {
  const flights: Omit<Flight, "flight_date" | "week_start">[] = [];

  for (const t of POC_DEMO_FLIGHT_TEMPLATES) {
    const seatCapacity = getSyntheticSeatCapacity(t.aircraft);
    for (const day of t.daysOfWeek) {
      const id = `${t.flightNumber.toLowerCase()}-${day.toLowerCase()}`;
      const departure = t.departureByDay[day];
      if (!departure) throw new Error(`"${t.flightNumber}" has no departureByDay entry for "${day}".`);
      flights.push({
        id,
        flight_number: t.flightNumber,
        airline: t.airline,
        route: `${t.origin} → ${t.destination}`,
        origin: t.origin,
        destination: t.destination,
        aircraft: t.aircraft,
        equipment_code: null,
        registration: null,
        callsign: null,
        terminal: t.operatorType === "atlas_managed" ? "T1" : "T2",
        scheduled_departure: departure,
        scheduled_arrival: null,
        gate: null,
        boarding_window_start: null,
        boarding_window_end: null,
        status: "scheduled",
        booking_pressure: t.bookingPressure,
        day_of_week: day,
        operator_type: t.operatorType,
        destination_category: t.operatorType === "self_managed" ? null : classifyDestinationOperationally(t.destination),
        seat_capacity: seatCapacity,
        booked_passengers: syntheticBookedPassengersFor(id, seatCapacity),
      });
    }
  }

  return flights;
}

/** Same role as the other two datasets' own companyOperatingDays helper — derives Qatar Airways' off-day rotation from its REAL flight days here. */
export function pocDemoCompanyOperatingDays(company: string): string[] {
  const days = new Set<string>();
  for (const t of POC_DEMO_FLIGHT_TEMPLATES) {
    if (t.airline !== company) continue;
    for (const d of t.daysOfWeek) days.add(d);
  }
  return ALL_DAYS.filter((d) => days.has(d));
}
