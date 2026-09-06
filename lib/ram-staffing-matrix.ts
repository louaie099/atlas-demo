/**
 * The single, authoritative RAM (Atlas-managed) staffing matrix: how many
 * Gate, Boarding, and Profiling agents a flight needs (aircraft-class
 * driven), and how many Mesure agents it needs (destination-driven) —
 * keyed by destination category, with aircraft class as a further
 * dimension ONLY for Gate/Boarding/Profiling. This is the one place these
 * numbers live; lib/operation-rules.ts (Gate/Boarding) and
 * lib/planning/specialized-demand.ts (Profiling/Mesure) both read from it
 * instead of keeping their own parallel copies, so the "same flight → same
 * rule everywhere" guarantee holds by construction, not by convention.
 *
 * IMPORTANT — as established by the operational brief: these are the
 * CURRENTLY CONFIRMED RAM staffing rules, not invented. Anything not
 * listed here (a destination category outside Africa/Europe/Schengen/
 * UK-USA/Canada, or a category×aircraft-class pair with no entry) has NO
 * established rule yet — callers must surface that as "needs
 * configuration", never guess a number.
 *
 * Canada, UK, and USA are the three CONFIRMED destinations requiring the
 * additional security/document-related functions (Profiling, Mesure).
 * Canada is kept as its OWN category (not merged into "UK/USA") even
 * though today's confirmed numbers happen to match — see
 * destination-classification.ts for why.
 *
 * Mesure is CONFIRMED at 4 agents per flight wherever it applies — but
 * that number is deliberately structured OUTSIDE the standard/dreamliner
 * split below: Mesure is destination-driven, never aircraft-driven (per
 * the operational brief), so there is no per-aircraft-class Mesure value
 * to look up, and the Dreamliner doubling that legitimately applies to
 * Gate/Boarding/Profiling must never be applied to it. Gate, Boarding, and
 * Profiling remain aircraft-class-driven exactly as before.
 */

export type RamDestinationCategory = "Africa" | "Europe/Schengen" | "UK/USA" | "Canada";

export interface RamAircraftClassCounts {
  gate: number;
  boarding: number;
  /** null = Profiling does not apply to this destination category at all — not a gap, just not relevant. */
  profiling: number | null;
}

export interface RamCategoryStaffingRule {
  standard: RamAircraftClassCounts;
  dreamliner: RamAircraftClassCounts;
  /**
   * null = Mesure does not apply to this destination category at all — not
   * a gap, just not relevant. A confirmed number is the REQUIRED headcount,
   * identical regardless of aircraft class (standard or Dreamliner) — see
   * the module comment above for why this deliberately has no per-
   * aircraft-class variant.
   */
  mesure: number | null;
}

const RAM_STAFFING_MATRIX: Record<RamDestinationCategory, RamCategoryStaffingRule> = {
  Africa: {
    standard: { gate: 1, boarding: 1, profiling: null },
    dreamliner: { gate: 2, boarding: 2, profiling: null },
    mesure: null,
  },
  "Europe/Schengen": {
    standard: { gate: 1, boarding: 1, profiling: 1 },
    dreamliner: { gate: 2, boarding: 2, profiling: 2 },
    mesure: null,
  },
  "UK/USA": {
    standard: { gate: 1, boarding: 1, profiling: 1 },
    dreamliner: { gate: 2, boarding: 2, profiling: 2 },
    mesure: 4,
  },
  Canada: {
    standard: { gate: 1, boarding: 1, profiling: 1 },
    dreamliner: { gate: 2, boarding: 2, profiling: 2 },
    mesure: 4,
  },
};

/**
 * Dreamliner = the Boeing 787 family ("Embraer/737-type" is everything
 * else per the brief). A generic substring check on the aircraft field,
 * never a hardcoded per-flight-number or per-airline special case —
 * consistent with how every other rule table in this codebase (company
 * config, foreign-shift matching) stays generic over its inputs.
 */
export function isDreamlinerAircraft(aircraft: string): boolean {
  return aircraft.includes("787");
}

/**
 * Looks up the established Gate/Boarding/Profiling counts for a
 * (destinationCategory, aircraft) pair — the aircraft-class-driven part of
 * the matrix. Returns null when there's no rule at all yet for this
 * category — the caller's job to surface as needs_configuration, never to
 * guess. Does NOT include Mesure — see getRamMesureHeadcount below.
 */
export function getRamRoleCounts(destinationCategory: string | null, aircraft: string): RamAircraftClassCounts | null {
  if (!destinationCategory) return null;
  const bucket = RAM_STAFFING_MATRIX[destinationCategory as RamDestinationCategory];
  if (!bucket) return null;
  return isDreamlinerAircraft(aircraft) ? bucket.dreamliner : bucket.standard;
}

/**
 * Looks up the confirmed Mesure headcount for a destination category —
 * deliberately takes NO aircraft parameter, since Mesure is destination-
 * driven only (never aircraft-driven; see the module comment above).
 * Returns null when Mesure doesn't apply to this category at all, or when
 * the category itself has no established rule yet.
 */
export function getRamMesureHeadcount(destinationCategory: string | null): number | null {
  if (!destinationCategory) return null;
  const bucket = RAM_STAFFING_MATRIX[destinationCategory as RamDestinationCategory];
  if (!bucket) return null;
  return bucket.mesure;
}
