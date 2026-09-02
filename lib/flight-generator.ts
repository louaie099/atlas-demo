import { Flight } from "./types";

/**
 * Recurring flight templates — same flight number, route, aircraft, and
 * time every day it operates, exactly like a real published schedule.
 * This is what keeps the generated week "coherent, not randomly
 * associated": a given flight number always maps to the same aircraft
 * and destination category, regardless of which day it's instantiated on.
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
  destinationCategory: string | null; // null for self_managed
  daysOfWeek: string[]; // which days this template operates
  bookingPressure: "normal" | "elevated";
}

const ALL_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const TEMPLATES: FlightTemplate[] = [
  { flightNumber: "AT100", airline: "Royal Air Maroc", origin: "CMN", destination: "MAD", aircraft: "Boeing 737-800", departure: "07:15", operatorType: "atlas_managed", destinationCategory: "Europe/Schengen", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  { flightNumber: "AT302", airline: "Royal Air Maroc", origin: "CMN", destination: "RAK", aircraft: "Boeing 737-800", departure: "08:00", operatorType: "atlas_managed", destinationCategory: "Domestic", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  { flightNumber: "AT650", airline: "Royal Air Maroc", origin: "CMN", destination: "IST", aircraft: "Airbus A320", departure: "11:20", operatorType: "atlas_managed", destinationCategory: "Africa", daysOfWeek: ["Monday", "Wednesday", "Friday", "Sunday"], bookingPressure: "normal" },
  { flightNumber: "AT401", airline: "Royal Air Maroc", origin: "CMN", destination: "FEZ", aircraft: "Boeing 737-800", departure: "12:40", operatorType: "atlas_managed", destinationCategory: "Domestic", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  { flightNumber: "AT740", airline: "Royal Air Maroc", origin: "CMN", destination: "LHR", aircraft: "Boeing 737-800", departure: "13:10", operatorType: "atlas_managed", destinationCategory: "Europe/Schengen", daysOfWeek: ["Monday", "Tuesday", "Thursday", "Saturday"], bookingPressure: "normal" },
  { flightNumber: "AT803", airline: "Royal Air Maroc", origin: "CMN", destination: "DKR", aircraft: "Boeing 737-800", departure: "18:30", operatorType: "atlas_managed", destinationCategory: "Africa", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  { flightNumber: "AT870", airline: "Royal Air Maroc", origin: "CMN", destination: "YUL", aircraft: "Boeing 787-9", departure: "23:00", operatorType: "atlas_managed", destinationCategory: "Long-haul", daysOfWeek: ["Tuesday", "Thursday", "Saturday", "Sunday"], bookingPressure: "normal" },
  { flightNumber: "QR1015", airline: "Qatar Airways", origin: "CMN", destination: "DOH", aircraft: "Airbus A350", departure: "17:20", operatorType: "self_managed", destinationCategory: null, daysOfWeek: ["Monday", "Wednesday", "Friday"], bookingPressure: "normal" },
  { flightNumber: "EK751", airline: "Emirates", origin: "CMN", destination: "DXB", aircraft: "Boeing 777-300ER", departure: "15:50", operatorType: "self_managed", destinationCategory: null, daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  { flightNumber: "EY603", airline: "Etihad", origin: "CMN", destination: "AUH", aircraft: "Airbus A320", departure: "19:40", operatorType: "self_managed", destinationCategory: null, daysOfWeek: ["Tuesday", "Thursday", "Sunday"], bookingPressure: "normal" },
  { flightNumber: "TK653", airline: "Turkish Airlines", origin: "CMN", destination: "IST", aircraft: "Airbus A321", departure: "20:15", operatorType: "self_managed", destinationCategory: null, daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
];

/**
 * Generates the full week's flights from the templates above, one Flight
 * record per (template, operating day). AT201 and AT535 are added
 * separately by the caller — this function never touches them.
 */
export function generateWeeklyFlights(): Flight[] {
  const flights: Flight[] = [];

  for (const t of TEMPLATES) {
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
        destination_category: t.destinationCategory,
      });
    }
  }

  return flights;
}
