import { Flight } from "../types";
import { classifyDestinationOperationally } from "../destination-classification";

/**
 * SMALL DEMO DATASET — flight side.
 *
 * Purpose (2026-10-04, requested by Moses): the main seeded dataset
 * (lib/seed-data.ts, ~200 employees / ~9-11 flights/day) is a deliberate
 * STRESS-TEST scale — good for exercising fairness, rotation, and
 * multi-week continuity logic, but too large to click through by hand
 * when manually testing Monthly Planning / Live Operations UI flows. This
 * module is a SEPARATE, independent flight schedule for a small, easy-to-
 * read demo — it does not replace, import from, or modify
 * lib/flight-generator.ts or lib/seed-data.ts in any way.
 *
 * Reuses the exact same real business-rule functions every other dataset
 * uses (classifyDestinationOperationally, and — via lib/ram-staffing-matrix.ts
 * at requirement-computation time — the same universal Gate/Boarding rule
 * and the same destination-gated Profiling/Mesure rule). Nothing about
 * staffing LOGIC is reimplemented here; only the flight SCHEDULE is
 * smaller.
 *
 * Deliberately sized for genuine tightness, not manufactured success:
 *  - 7 RAM (atlas_managed) flights every day (8-10/day including the two
 *    day-specific ones below), spanning Domestic, Europe/Schengen, Africa,
 *    and UK/USA categories, standard AND Dreamliner aircraft.
 *  - One self-managed carrier with a small, real company_config headcount
 *    (Qatar Airways, 2 agents/flight) so the foreign-company path is
 *    exercised without consuming a disproportionate share of a 20-25
 *    person roster.
 *  - One self-managed, UNCONFIGURED carrier (Turkish Airlines) — the
 *    "real schedule noise with zero staffing cost" case, same honest
 *    "unmanaged" path as the main dataset's TK653.
 *  - One UK/USA flight (AT225/LHR) is the only Profiling+Mesure trigger —
 *    deliberately the ONLY one, since Mesure's confirmed flat 4-agent
 *    requirement is expensive relative to a small roster; two such flights
 *    would force an oversized Mesure team just to stay feasible, which
 *    would misrepresent "small but tight" as "small and starved."
 *
 * Flight numbers use RAM's real "AT" prefix (not a made-up code) — chosen
 * to NOT collide with any flight number the main dataset already uses
 * (lib/flight-generator.ts's TEMPLATES / lib/seed-data.ts's
 * SCRIPTED_FLIGHTS: AT100, AT201, AT302, AT401, AT535, AT650, AT740,
 * AT803, AT870). This dataset's own numbers (AT120, AT160, AT225, AT310,
 * AT420, AT560, AT660, AT815) are deliberately outside that set, so the
 * two datasets' flights are never confusable even if both were ever
 * imported into the same week.
 */

const ALL_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MON_WED_FRI = ["Monday", "Wednesday", "Friday"];
const TUE_THU_SAT_SUN = ["Tuesday", "Thursday", "Saturday", "Sunday"];

interface SmallFlightTemplate {
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

// Same illustrative synthetic capacity convention as lib/flight-generator.ts
// — presentation-only, not a claim about any airline's real configuration.
const SYNTHETIC_DEMO_AIRCRAFT_CAPACITY: Record<string, number> = {
  "Boeing 737-800": 189,
  "Boeing 787-9": 296,
  "Airbus A350": 325,
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

function syntheticBookedPassengersFor(
  flightInstanceKey: string,
  capacity: number | null,
  bookingPressure: "normal" | "elevated"
): number | null {
  if (capacity === null) return null;
  const [minFactor, maxFactor] = bookingPressure === "elevated" ? [0.9, 0.99] : [0.72, 0.88];
  const spread = stableHash(flightInstanceKey) % 1000;
  const loadFactor = minFactor + (spread / 999) * (maxFactor - minFactor);
  const booked = Math.round(capacity * loadFactor);
  return Math.min(Math.max(booked, 0), capacity);
}

/**
 * The small demo's flight program. Flight numbers deliberately reuse the
 * SMxxx range (never AT1xx/AT2xx/AT3xx/etc., which are the main dataset's
 * protected/generated numbers) so the two datasets' flights are never
 * visually confusable if both were ever displayed side by side.
 */
export const SMALL_DEMO_FLIGHT_TEMPLATES: SmallFlightTemplate[] = [
  // ---- Daily RAM core (7 flights, every day) ----
  { flightNumber: "AT120", airline: "Royal Air Maroc", origin: "CMN", destination: "MAD", aircraft: "Boeing 737-800", departure: "07:15", operatorType: "atlas_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  { flightNumber: "AT310", airline: "Royal Air Maroc", origin: "CMN", destination: "RAK", aircraft: "Boeing 737-800", departure: "08:30", operatorType: "atlas_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  { flightNumber: "AT160", airline: "Royal Air Maroc", origin: "CMN", destination: "RAK", aircraft: "Boeing 737-800", departure: "15:10", operatorType: "atlas_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  { flightNumber: "AT420", airline: "Royal Air Maroc", origin: "CMN", destination: "FEZ", aircraft: "Boeing 737-800", departure: "10:40", operatorType: "atlas_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  { flightNumber: "AT560", airline: "Royal Air Maroc", origin: "CMN", destination: "ORY", aircraft: "Boeing 737-800", departure: "12:50", operatorType: "atlas_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  // Dreamliner on a Domestic/Africa-shaped route — exercises the
  // aircraft-class-driven 2x Gate/Boarding rule WITHOUT also triggering
  // Profiling/Mesure (Africa has no confirmed Profiling/Mesure category —
  // see destination-classification.ts), so it doesn't compound with
  // AT225's Mesure demand below. Deliberately an EARLY-AFTERNOON departure
  // (not late evening): with a tiny roster, clustering demand across the
  // whole clock (early morning AND late evening every single day) forces
  // every flexible-pool employee onto a long evening shift just to cover
  // the one late flight — which then leaves nobody rest-legal for the
  // NEXT day's early flights, a cascading rest lockout that reads as a
  // confusing total-blackout bug, not an honest bottleneck. Keeping the
  // whole RAM core within a single legal shift's span (05:45-15:00ish)
  // lets the real, intended bottlenecks (Mesure, Profiling — see
  // employees.ts) show up on their own, without this artifact.
  { flightNumber: "AT815", airline: "Royal Air Maroc", origin: "CMN", destination: "DKR", aircraft: "Boeing 787-9", departure: "13:45", operatorType: "atlas_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  // Self-managed, deliberately UNCONFIGURED carrier — real schedule entry,
  // zero staffing cost, same "unmanaged" path as the main dataset's TK653
  // (lib/flight-generator.ts).
  { flightNumber: "TK653", airline: "Turkish Airlines", origin: "CMN", destination: "IST", aircraft: "Airbus A321", departure: "20:40", operatorType: "self_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },

  // ---- Monday/Wednesday/Friday (the one Profiling+Mesure trigger + the one foreign carrier) ----
  { flightNumber: "AT225", airline: "Royal Air Maroc", origin: "CMN", destination: "LHR", aircraft: "Boeing 737-800", departure: "13:10", operatorType: "atlas_managed", daysOfWeek: MON_WED_FRI, bookingPressure: "normal" },
  { flightNumber: "QR1015", airline: "Qatar Airways", origin: "CMN", destination: "DOH", aircraft: "Airbus A350", departure: "17:20", operatorType: "self_managed", daysOfWeek: MON_WED_FRI, bookingPressure: "normal" },

  // ---- Tuesday/Thursday/Saturday/Sunday (a second domestic rotation) ----
  { flightNumber: "AT660", airline: "Royal Air Maroc", origin: "CMN", destination: "RAK", aircraft: "Boeing 737-800", departure: "15:20", operatorType: "atlas_managed", daysOfWeek: TUE_THU_SAT_SUN, bookingPressure: "normal" },
];

/**
 * Generates the small demo's flights — same shape/derivation pattern as
 * lib/flight-generator.ts's generateWeeklyFlights, but from this module's
 * own, much smaller template set. flight_date/week_start are attached by
 * the caller (lib/demo-small/dataset.ts), same division of responsibility
 * as the main dataset.
 */
export function generateSmallDemoFlights(): Omit<Flight, "flight_date" | "week_start">[] {
  const flights: Omit<Flight, "flight_date" | "week_start">[] = [];

  for (const t of SMALL_DEMO_FLIGHT_TEMPLATES) {
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
        booked_passengers: syntheticBookedPassengersFor(id, seatCapacity, t.bookingPressure),
      });
    }
  }

  return flights;
}

/** Same role as lib/flight-generator.ts's companyOperatingDays, scoped to this module's own templates — used to derive Qatar Airways' off-day rotation from its REAL flight days here, never a guessed/independent number. */
export function smallDemoCompanyOperatingDays(company: string): string[] {
  const days = new Set<string>();
  for (const t of SMALL_DEMO_FLIGHT_TEMPLATES) {
    if (t.airline !== company) continue;
    for (const d of t.daysOfWeek) days.add(d);
  }
  return ALL_DAYS.filter((d) => days.has(d));
}
