import { RamDestinationCategory } from "./ram-staffing-matrix";

/**
 * Factual destination data — airport code -> city/country. This is data
 * about the world, not an operational decision: knowing a flight goes to
 * LHR doesn't by itself say which staffing rule applies. Classification
 * (below) is a separate step that reads this data.
 *
 * Only airports actually used by the seeded flight schedule are listed.
 * An airport absent here is not guessed at — classifyDestinationOperationally
 * returns null for it, the same as a country with no confirmed category.
 */
export const DESTINATIONS: Record<string, { code: string; city: string; country: string }> = {
  MAD: { code: "MAD", city: "Madrid", country: "Spain" },
  LHR: { code: "LHR", city: "London", country: "United Kingdom" },
  RAK: { code: "RAK", city: "Marrakech", country: "Morocco" },
  FEZ: { code: "FEZ", city: "Fez", country: "Morocco" },
  IST: { code: "IST", city: "Istanbul", country: "Turkey" },
  DKR: { code: "DKR", city: "Dakar", country: "Senegal" },
  YUL: { code: "YUL", city: "Montreal", country: "Canada" },
  DOH: { code: "DOH", city: "Doha", country: "Qatar" },
  DXB: { code: "DXB", city: "Dubai", country: "United Arab Emirates" },
  AUH: { code: "AUH", city: "Abu Dhabi", country: "United Arab Emirates" },
  CDG: { code: "CDG", city: "Paris", country: "France" },
  ORY: { code: "ORY", city: "Paris", country: "France" },
  BAH: { code: "BAH", city: "Manama", country: "Bahrain" },
};

/**
 * Country -> confirmed RAM Profiling/Mesure category. ONLY countries with
 * an actual confirmed Profiling/Mesure rule appear here — this is
 * deliberately short. A country's absence (Turkey, the Gulf states, etc.)
 * means no confirmed Profiling/Mesure category exists for it — NOT that
 * RAM has no staffing rule for the flight at all. Since the 2026-10-04
 * revision, Gate/Boarding is a universal rule for every RAM flight
 * regardless of this table (see ram-staffing-matrix.ts) — this mapping
 * only ever decides Profiling/Mesure applicability now. Do not extend this
 * table to "make a flight fit" — extend it only when a real confirmed
 * Profiling/Mesure rule exists for that country.
 *
 * Canada is its own category, not folded into "UK/USA" — the CONFIRMED
 * RULE (additional security/document-related functions: Profiling, Mesure)
 * happens to be identical to UK/USA today (see ram-staffing-matrix.ts), but
 * that is a coincidence of the current confirmed numbers, not a reason to
 * merge the categories — a future change to one must not silently apply to
 * the other.
 */
const COUNTRY_TO_RAM_CATEGORY: Partial<Record<string, RamDestinationCategory>> = {
  Spain: "Europe/Schengen",
  France: "Europe/Schengen",
  "United Kingdom": "UK/USA",
  "United States": "UK/USA",
  Canada: "Canada",
  Senegal: "Africa",
};

/**
 * Destination/airport -> operational classification. This is the ONLY
 * function that should decide a flight's destination_category — never a
 * hand-typed literal on a flight template.
 *
 * - Morocco is a confident classification ("Domestic"). Gate/Boarding is
 *   universal for every RAM flight regardless of category (see
 *   ram-staffing-matrix.ts's 2026-10-04 revision), so "Domestic" having no
 *   Profiling/Mesure entry is a confirmed "not applicable" answer, not a
 *   gap — same as Africa.
 * - A country with a confirmed Profiling/Mesure category (Spain/France ->
 *   Europe/Schengen, United Kingdom/United States -> UK/USA, Canada ->
 *   Canada, Senegal -> Africa) returns that category directly.
 * - Everything else (Turkey, Bahrain, the UAE, Qatar, or an airport not in
 *   DESTINATIONS at all) returns null — genuinely unclassifiable for
 *   Profiling/Mesure purposes with what's currently confirmed. This no
 *   longer blocks Gate/Boarding, which is universal. Never guessed into
 *   the nearest-sounding Profiling/Mesure bucket.
 */
export function classifyDestinationOperationally(
  destinationCode: string | null
): "Domestic" | RamDestinationCategory | null {
  if (!destinationCode) return null;
  const dest = DESTINATIONS[destinationCode];
  if (!dest) return null;
  if (dest.country === "Morocco") return "Domestic";
  return COUNTRY_TO_RAM_CATEGORY[dest.country] ?? null;
}
