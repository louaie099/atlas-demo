import { classifyDestinationOperationally } from "./destination-classification";
import { dayOfWeekFor, weekStartFor } from "./flight-date";
import { Flight } from "./types";

/**
 * Import Flights column format for the prototype. flight_date (a real
 * calendar date, "YYYY-MM-DD") is the required date column — never
 * day_of_week alone, matching the same flight_date-is-authoritative rule
 * the rest of the app now follows (see lib/flight-date.ts). day_of_week
 * is always derived from it, never taken from the file.
 *
 * XLSX is not yet wired up (would need a new parsing dependency added
 * deliberately, not as a side effect of this milestone) — CSV is the
 * supported prototype format for now; this is a real, practical format,
 * not a placeholder, and every validation/preview/commit behavior below
 * is format-agnostic once rows are parsed into ParsedFlightRow.
 */
export const IMPORT_COLUMNS = [
  "flight_number",
  "airline",
  "origin",
  "destination",
  "flight_date",
  "scheduled_departure",
  "aircraft",
  "scheduled_arrival",
  "booking_pressure",
  "terminal",
] as const;

const REQUIRED_COLUMNS = ["flight_number", "airline", "origin", "destination", "flight_date", "scheduled_departure", "aircraft"];

export interface ParsedFlightRow {
  rowNumber: number; // 1-based, matching what a person sees if they open the file in a spreadsheet (header is row 1)
  raw: Record<string, string>;
  status: "ready" | "warning" | "rejected";
  problems: string[]; // human-readable; rejected rows have at least one, warning rows have at least one non-blocking note
  flight: Flight | null; // fully derived Flight, ready to insert -- present for "ready" and "warning" rows, null for "rejected"
}

/**
 * Minimal, dependency-free CSV parser: handles quoted fields (including
 * embedded commas and escaped `""`), trims cell whitespace, skips blank
 * lines. Deliberately not a full RFC 4180 implementation (e.g. no
 * embedded-newline-inside-quotes support) -- sufficient for the flat,
 * single-line-per-flight format this import expects; a row that doesn't
 * fit this shape surfaces as a rejected row with a clear reason rather
 * than silently mis-parsing.
 */
export function parseCSV(text: string): { header: string[]; rows: string[][] } {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  function parseLine(line: string): string[] {
    const cells: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (c === '"') {
          inQuotes = false;
        } else {
          cur += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        cells.push(cur.trim());
        cur = "";
      } else {
        cur += c;
      }
    }
    cells.push(cur.trim());
    return cells;
  }
  if (lines.length === 0) return { header: [], rows: [] };
  const header = parseLine(lines[0]).map((h) => h.toLowerCase());
  const rows = lines.slice(1).map(parseLine);
  return { header, rows };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Validates and derives a full Flight from one parsed row, against the
 * SAME rules Add Flight uses (destination_category/operator_type/
 * day_of_week/week_start always derived, never taken from the file) --
 * an imported flight and a manually-added one are indistinguishable to
 * every downstream planning function. `existingKeys` and `seenInFile`
 * both use `${flight_date}|${flight_number}` as the duplicate-identity
 * key, matching the database's own flights_date_number_unique
 * constraint -- checked against both the already-persisted flights for
 * this week (existingKeys) and every row already accepted earlier in
 * THIS SAME file (seenInFile), so two rows in one import that collide
 * with each other are caught just as reliably as a collision with an
 * already-imported flight.
 */
export function validateRow(rowNumber: number, raw: Record<string, string>, existingKeys: Set<string>, seenInFile: Set<string>): ParsedFlightRow {
  const problems: string[] = [];

  const missing = REQUIRED_COLUMNS.filter((c) => !raw[c]?.trim());
  if (missing.length > 0) {
    return { rowNumber, raw, status: "rejected", problems: [`Missing required value(s): ${missing.join(", ")}`], flight: null };
  }

  const flight_number = raw.flight_number.trim();
  const airline = raw.airline.trim();
  const origin = raw.origin.trim().toUpperCase();
  const destination = raw.destination.trim().toUpperCase();
  const flight_date = raw.flight_date.trim();
  const scheduled_departure = raw.scheduled_departure.trim();
  const aircraft = raw.aircraft.trim();
  const scheduled_arrival = raw.scheduled_arrival?.trim() || null;
  const booking_pressure = (raw.booking_pressure?.trim().toLowerCase() || "normal") as "normal" | "elevated";
  const terminal = raw.terminal?.trim() || "T1";

  if (!/^\d{4}-\d{2}-\d{2}$/.test(flight_date)) {
    problems.push(`flight_date "${raw.flight_date}" is not a valid YYYY-MM-DD date`);
  }
  if (!/^\d{2}:\d{2}$/.test(scheduled_departure)) {
    problems.push(`scheduled_departure "${raw.scheduled_departure}" is not a valid HH:mm time`);
  }
  if (scheduled_arrival && !/^\d{2}:\d{2}$/.test(scheduled_arrival)) {
    problems.push(`scheduled_arrival "${raw.scheduled_arrival}" is not a valid HH:mm time`);
  }
  if (booking_pressure !== "normal" && booking_pressure !== "elevated") {
    problems.push(`booking_pressure "${raw.booking_pressure}" must be "normal" or "elevated"`);
  }
  if (problems.length > 0) {
    return { rowNumber, raw, status: "rejected", problems, flight: null };
  }

  const key = `${flight_date}|${flight_number}`;
  if (existingKeys.has(key)) {
    return { rowNumber, raw, status: "rejected", problems: [`${flight_number} on ${flight_date} already exists for this week — duplicate`], flight: null };
  }
  if (seenInFile.has(key)) {
    return { rowNumber, raw, status: "rejected", problems: [`${flight_number} on ${flight_date} appears more than once in this file`], flight: null };
  }

  const warnings: string[] = [];
  const destinationCategory = classifyDestinationOperationally(destination);
  if (destinationCategory === null) {
    warnings.push(`Destination "${destination}" isn't in the confirmed classification table yet — this flight will need configuration before it gets staffing coverage`);
  }

  const dayOfWeek = dayOfWeekFor(flight_date);
  const weekStart = weekStartFor(flight_date);
  const operatorType = airline === "Royal Air Maroc" ? "atlas_managed" : "self_managed";

  const flight: Flight = {
    id: `${slugify(flight_number)}-${flight_date}`,
    flight_number,
    airline,
    route: `${origin} → ${destination}`,
    origin,
    destination,
    aircraft,
    equipment_code: null,
    registration: null,
    callsign: null,
    terminal,
    scheduled_departure,
    scheduled_arrival,
    gate: null,
    boarding_window_start: null,
    boarding_window_end: null,
    status: "scheduled",
    booking_pressure,
    day_of_week: dayOfWeek,
    flight_date,
    week_start: weekStart,
    operator_type: operatorType,
    destination_category: destinationCategory,
    booked_passengers: null,
    seat_capacity: null,
  };

  return { rowNumber, raw, status: warnings.length > 0 ? "warning" : "ready", problems: warnings, flight };
}

export function validateImportFile(csvText: string, existingKeys: Set<string>): ParsedFlightRow[] {
  const { header, rows } = parseCSV(csvText);
  const missingColumns = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missingColumns.length > 0) {
    throw new Error(`CSV is missing required column(s): ${missingColumns.join(", ")}. Expected columns: ${IMPORT_COLUMNS.join(", ")}`);
  }

  const seenInFile = new Set<string>();
  const results: ParsedFlightRow[] = [];
  rows.forEach((cells, i) => {
    const raw: Record<string, string> = {};
    header.forEach((col, colIdx) => {
      raw[col] = cells[colIdx] ?? "";
    });
    const result = validateRow(i + 2, raw, existingKeys, seenInFile); // +2: 1-based, plus the header row
    if (result.flight) seenInFile.add(`${result.flight.flight_date}|${result.flight.flight_number}`);
    results.push(result);
  });
  return results;
}
