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
 * and neither of them is touched by this one's existence.
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
 *  - AT501 (CMN->RAK, Domestic, daily) and AT503 (CMN->FEZ, Domestic,
 *    daily) are the two ordinary RAM core flights — universal Gate +
 *    Boarding demand, standard 737. AT503's Wednesday departure is the
 *    flight live-delayed during Scenario B/C (see that module's own
 *    verification notes in tests/poc-demo-dataset.test.ts for exactly why
 *    Wednesday and exactly why this delay amount).
 * *  - AT502 (CMN->ORY, Europe/Schengen -> triggers the universal
 *    Gate/Boarding rule PLUS the real Profiling rule, 1 agent/flight,
 *    standard aircraft) runs DAILY, deliberately against only ONE
 *    Profiling-qualified employee (employees.ts) — a single person
 *    working a normal 5-day week (2 OFF days, the same confirmed rule
 *    every employee in this app follows) can physically cover at most 5
 *    of AT502's 7 weekly instances, so at least 2 days are a REAL,
 *    headcount-forced Profiling gap regardless of which 2 days the
 *    engine's own OFF-day optimizer picks — Scenario D. The remaining
 *    covered days are the "normally feasible" healthy case — Scenario A.
 *    See tests/poc-demo-dataset.test.ts for the actual engine-computed
 *    OFF days and which specific days end up short — not asserted here.
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
  departure: string; // "HH:mm"
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
export const POC_DEMO_FLIGHT_TEMPLATES: PocFlightTemplate[] = [
  { flightNumber: "AT501", airline: "Royal Air Maroc", origin: "CMN", destination: "RAK", aircraft: "Boeing 737-800", departure: "07:30", operatorType: "atlas_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  { flightNumber: "AT503", airline: "Royal Air Maroc", origin: "CMN", destination: "FEZ", aircraft: "Boeing 737-800", departure: "14:00", operatorType: "atlas_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  { flightNumber: "AT502", airline: "Royal Air Maroc", origin: "CMN", destination: "ORY", aircraft: "Boeing 737-800", departure: "11:30", operatorType: "atlas_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  { flightNumber: "QR601", airline: "Qatar Airways", origin: "CMN", destination: "DOH", aircraft: "Airbus A321", departure: "18:30", operatorType: "self_managed", daysOfWeek: MON_WED_FRI, bookingPressure: "normal" },
  { flightNumber: "TK601", airline: "Turkish Airlines", origin: "CMN", destination: "IST", aircraft: "Airbus A321", departure: "20:15", operatorType: "self_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
];

/** Same generation shape as the other two datasets' own generators — flight_date/week_start are attached by the caller (dataset.ts). */
export function generatePocDemoFlights(): Omit<Flight, "flight_date" | "week_start">[] {
  const flights: Omit<Flight, "flight_date" | "week_start">[] = [];

  for (const t of POC_DEMO_FLIGHT_TEMPLATES) {
    const seatCapacity = getSyntheticSeatCapacity(t.aircraft);
    for (const day of t.daysOfWeek) {
      const id = `${t.flightNumber.toLowerCase()}-${day.toLowerCase()}`;
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
        scheduled_departure: t.departure,
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
