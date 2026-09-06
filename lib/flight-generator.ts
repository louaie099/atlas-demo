import { Flight } from "./types";
import { classifyDestinationOperationally } from "./destination-classification";

/**
 * Recurring flight templates — same flight number, route, aircraft, and
 * time every day it operates, exactly like a real published schedule.
 * This is what keeps the generated week "coherent, not randomly
 * associated": a given flight number always maps to the same aircraft
 * and destination, regardless of which day it's instantiated on.
 *
 * Operational classification (destinationCategory) is NOT hand-typed here
 * anymore — it's computed from the destination via
 * classifyDestinationOperationally (lib/destination-classification.ts),
 * so a flight can never be classified just to make it fit an existing
 * rule. See generateWeeklyFlights below.
 *
 * AT201 and AT535 are NOT here — they remain the hand-authored, protected
 * scripted flights in seed-data.ts, untouched by generation.
 */
interface FlightTemplate {
  flightNumber: string;
  airline: string;
  origin: string;
  destination: string;
  aircraft: string;
  departure: string; // "HH:mm"
  operatorType: "atlas_managed" | "self_managed";
  daysOfWeek: string[]; // which days this template operates
  bookingPressure: "normal" | "elevated";
}

const ALL_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/**
 * Seat capacity by aircraft type — factual aircraft data, not a staffing
 * input by itself (see Flight.seat_capacity's doc comment in lib/types.ts:
 * passenger load is architecture-only, made available for future planning
 * logic, not consumed by any staffing rule yet). An aircraft type absent
 * here gets a null capacity rather than a guessed figure.
 */
const AIRCRAFT_SEAT_CAPACITY: Record<string, number> = {
  "Boeing 737-800": 189,
  "Airbus A320": 180,
  "Airbus A321": 220,
  "Airbus A350": 325,
  "Boeing 777-300ER": 396,
  "Boeing 787-9": 296,
};

/**
 * A deterministic, illustrative booked-passenger figure derived from the
 * template's own booking_pressure — never a random number, so re-running
 * generation always produces the same demo data. This is demo data, same
 * caveat as the rest of this file's TEMPLATES: not real booking figures.
 */
function bookedPassengersFor(capacity: number | null, bookingPressure: "normal" | "elevated"): number | null {
  if (capacity === null) return null;
  const loadFactor = bookingPressure === "elevated" ? 0.96 : 0.82;
  return Math.round(capacity * loadFactor);
}

const TEMPLATES: FlightTemplate[] = [
  { flightNumber: "AT100", airline: "Royal Air Maroc", origin: "CMN", destination: "MAD", aircraft: "Boeing 737-800", departure: "07:15", operatorType: "atlas_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  { flightNumber: "AT302", airline: "Royal Air Maroc", origin: "CMN", destination: "RAK", aircraft: "Boeing 737-800", departure: "08:00", operatorType: "atlas_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  // AT650/IST: Turkey has no confirmed RAM operational category — this
  // used to be hand-typed as "Africa" to avoid a needs_configuration row.
  // That was a classification bug, not a real rule; it now correctly
  // comes out of classifyDestinationOperationally as null (unconfigured).
  { flightNumber: "AT650", airline: "Royal Air Maroc", origin: "CMN", destination: "IST", aircraft: "Airbus A320", departure: "11:20", operatorType: "atlas_managed", daysOfWeek: ["Monday", "Wednesday", "Friday", "Sunday"], bookingPressure: "normal" },
  { flightNumber: "AT401", airline: "Royal Air Maroc", origin: "CMN", destination: "FEZ", aircraft: "Boeing 737-800", departure: "12:40", operatorType: "atlas_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  // AT740/LHR: United Kingdom -> UK/USA operational category, not
  // Europe/Schengen (a prior misclassification corrected here).
  { flightNumber: "AT740", airline: "Royal Air Maroc", origin: "CMN", destination: "LHR", aircraft: "Boeing 737-800", departure: "13:10", operatorType: "atlas_managed", daysOfWeek: ["Monday", "Tuesday", "Thursday", "Saturday"], bookingPressure: "normal" },
  { flightNumber: "AT803", airline: "Royal Air Maroc", origin: "CMN", destination: "DKR", aircraft: "Boeing 737-800", departure: "18:30", operatorType: "atlas_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  // AT870/YUL: Canada has no confirmed RAM operational category either —
  // previously labeled "Long-haul" (not a real category name at all).
  // Now genuinely surfaces as unconfigured, same as any other
  // unclassifiable destination.
  { flightNumber: "AT870", airline: "Royal Air Maroc", origin: "CMN", destination: "YUL", aircraft: "Boeing 787-9", departure: "23:00", operatorType: "atlas_managed", daysOfWeek: ["Tuesday", "Thursday", "Saturday", "Sunday"], bookingPressure: "normal" },
  { flightNumber: "QR1015", airline: "Qatar Airways", origin: "CMN", destination: "DOH", aircraft: "Airbus A350", departure: "17:20", operatorType: "self_managed", daysOfWeek: ["Monday", "Wednesday", "Friday"], bookingPressure: "normal" },
  { flightNumber: "EK751", airline: "Emirates", origin: "CMN", destination: "DXB", aircraft: "Boeing 777-300ER", departure: "15:50", operatorType: "self_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  { flightNumber: "EY603", airline: "Etihad", origin: "CMN", destination: "AUH", aircraft: "Airbus A320", departure: "19:40", operatorType: "self_managed", daysOfWeek: ["Tuesday", "Thursday", "Sunday"], bookingPressure: "normal" },
  { flightNumber: "TK653", airline: "Turkish Airlines", origin: "CMN", destination: "IST", aircraft: "Airbus A321", departure: "20:15", operatorType: "self_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  // ASSUMPTION (flagged): Gulf Air and Air France were both configured in
  // company-config.ts (with dedicated employee groups) but had ZERO
  // seeded flights — meaning their "foreign-company flight requirements
  // take priority" rule was never actually exercised for either company.
  // These two flights are added so that rule is testable. Gulf Air's
  // 09:00 departure matches the brief's own worked example.
  { flightNumber: "GF105", airline: "Gulf Air", origin: "CMN", destination: "BAH", aircraft: "Airbus A320", departure: "09:00", operatorType: "self_managed", daysOfWeek: ["Monday", "Wednesday", "Friday", "Sunday"], bookingPressure: "normal" },
  { flightNumber: "AF1234", airline: "Air France", origin: "CMN", destination: "CDG", aircraft: "Airbus A321", departure: "10:30", operatorType: "self_managed", daysOfWeek: ["Tuesday", "Thursday", "Saturday"], bookingPressure: "normal" },
];

/**
 * Generates the full week's flights from the templates above, one Flight
 * record per (template, operating day). AT201 and AT535 are added
 * separately by the caller — this function never touches them.
 */
export function generateWeeklyFlights(): Flight[] {
  const flights: Flight[] = [];

  for (const t of TEMPLATES) {
    const seatCapacity = AIRCRAFT_SEAT_CAPACITY[t.aircraft] ?? null;
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
        // Self-managed (foreign-carrier) flights never go through the RAM
        // staffing matrix — company_config drives those instead, so the
        // category is null regardless of destination. Atlas-managed
        // flights get their category computed from the real destination,
        // never hand-typed.
        destination_category: t.operatorType === "self_managed" ? null : classifyDestinationOperationally(t.destination),
        seat_capacity: seatCapacity,
        booked_passengers: bookedPassengersFor(seatCapacity, t.bookingPressure),
      });
    }
  }

  return flights;
}

/**
 * The set of days a given (self-managed) company actually operates a
 * flight from CMN, as published in the templates above — used by the
 * roster generator so a foreign-company employee's off days can
 * preferentially fall on days their own company has no flight at all,
 * instead of being chosen independently of that commitment. Returns an
 * empty array for a company with no seeded flights (never guessed).
 */
export function companyOperatingDays(company: string): string[] {
  const days = new Set<string>();
  for (const t of TEMPLATES) {
    if (t.airline !== company) continue;
    for (const d of t.daysOfWeek) days.add(d);
  }
  return ALL_DAYS.filter((d) => days.has(d));
}
