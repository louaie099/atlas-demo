import { Flight } from "./types";
import { classifyDestinationOperationally } from "./destination-classification";

interface FlightTemplate {
  flightNumber: string;
  airline: string;
  origin: string;
  destination: string;
  aircraft: string;
  departure: string;
  operatorType: "atlas_managed" | "self_managed";
  daysOfWeek: string[];
  bookingPressure: "normal" | "elevated";
}

const ALL_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const TEMPLATES: FlightTemplate[] = [
  { flightNumber: "AT100", airline: "Royal Air Maroc", origin: "CMN", destination: "MAD", aircraft: "Boeing 737-800", departure: "07:15", operatorType: "atlas_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  { flightNumber: "AT302", airline: "Royal Air Maroc", origin: "CMN", destination: "RAK", aircraft: "Boeing 737-800", departure: "08:00", operatorType: "atlas_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  { flightNumber: "AT650", airline: "Royal Air Maroc", origin: "CMN", destination: "IST", aircraft: "Airbus A320", departure: "11:20", operatorType: "atlas_managed", daysOfWeek: ["Monday", "Wednesday", "Friday", "Sunday"], bookingPressure: "normal" },
  { flightNumber: "AT401", airline: "Royal Air Maroc", origin: "CMN", destination: "FEZ", aircraft: "Boeing 737-800", departure: "12:40", operatorType: "atlas_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  { flightNumber: "AT740", airline: "Royal Air Maroc", origin: "CMN", destination: "LHR", aircraft: "Boeing 737-800", departure: "13:10", operatorType: "atlas_managed", daysOfWeek: ["Monday", "Tuesday", "Thursday", "Saturday"], bookingPressure: "normal" },
  { flightNumber: "AT803", airline: "Royal Air Maroc", origin: "CMN", destination: "DKR", aircraft: "Boeing 737-800", departure: "18:30", operatorType: "atlas_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  { flightNumber: "AT870", airline: "Royal Air Maroc", origin: "CMN", destination: "YUL", aircraft: "Boeing 787-9", departure: "23:00", operatorType: "atlas_managed", daysOfWeek: ["Tuesday", "Thursday", "Saturday", "Sunday"], bookingPressure: "normal" },
  { flightNumber: "QR1015", airline: "Qatar Airways", origin: "CMN", destination: "DOH", aircraft: "Airbus A350", departure: "17:20", operatorType: "self_managed", daysOfWeek: ["Monday", "Wednesday", "Friday"], bookingPressure: "normal" },
  { flightNumber: "EK751", airline: "Emirates", origin: "CMN", destination: "DXB", aircraft: "Boeing 777-300ER", departure: "15:50", operatorType: "self_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  { flightNumber: "EY603", airline: "Etihad", origin: "CMN", destination: "AUH", aircraft: "Airbus A320", departure: "19:40", operatorType: "self_managed", daysOfWeek: ["Tuesday", "Thursday", "Sunday"], bookingPressure: "normal" },
  { flightNumber: "TK653", airline: "Turkish Airlines", origin: "CMN", destination: "IST", aircraft: "Airbus A321", departure: "20:15", operatorType: "self_managed", daysOfWeek: ALL_DAYS, bookingPressure: "normal" },
  { flightNumber: "GF105", airline: "Gulf Air", origin: "CMN", destination: "BAH", aircraft: "Airbus A320", departure: "09:00", operatorType: "self_managed", daysOfWeek: ["Monday", "Wednesday", "Friday", "Sunday"], bookingPressure: "normal" },
  { flightNumber: "AF1234", airline: "Air France", origin: "CMN", destination: "CDG", aircraft: "Airbus A321", departure: "10:30", operatorType: "self_managed", daysOfWeek: ["Tuesday", "Thursday", "Saturday"], bookingPressure: "normal" },
];

export function generateWeeklyFlights(): Flight[] {
  const flights: Flight[] = [];

  for (const t of TEMPLATES) {
    for (const day of t.daysOfWeek) {
      const id = `${t.flightNumber.toLowerCase()}-${day.toLowerCase()}`;
      flights.push({
        id,
        flight_number: t.flightNumber,
        airline: t.airline,
        route: `${t.origin} -> ${t.destination}`,
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
      });
    }
  }

  return flights;
}

export function companyOperatingDays(company: string): string[] {
  const days = new Set<string>();
  for (const t of TEMPLATES) {
    if (t.airline !== company) continue;
    for (const d of t.daysOfWeek) days.add(d);
  }
  return ALL_DAYS.filter((d) => days.has(d));
}
