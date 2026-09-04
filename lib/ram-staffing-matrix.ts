/**
 * The single, authoritative RAM (Atlas-managed) staffing matrix: how many
 * Gate, Boarding, and Profiling agents a flight needs, and whether Mesure
 * applies at all — keyed by destination category and aircraft class
 * (standard vs. Dreamliner). This is the one place these numbers live;
 * lib/operation-rules.ts (Gate/Boarding) and lib/planning/specialized-demand.ts
 * (Profiling/Mesure) both read from it instead of keeping their own
 * parallel copies, so the "same flight → same rule everywhere" guarantee
 * holds by construction, not by convention.
 *
 * IMPORTANT — as established by the operational brief: these are the
 * CURRENTLY CONFIRMED RAM staffing rules, not invented. Anything not
 * listed here (a destination category outside Africa/Europe/Schengen/
 * UK-USA, or a category×aircraft-class pair with no entry) has NO
 * established rule yet — callers must surface that as "needs
 * configuration", never guess a number. In particular: the exact Mesure
 * HEADCOUNT has not been confirmed for any category — `mesureApplicable`
 * only records THAT Mesure applies to UK/USA flights, never how many.
 */

export type RamDestinationCategory = "Africa" | "Europe/Schengen" | "UK/USA";

export interface RamRoleCounts {
  gate: number;
  boarding: number;
  /** null = Profiling does not apply to this destination category at all — not a gap, just not relevant. */
  profiling: number | null;
  /** true = Mesure applies to this category, but the required headcount is not yet confirmed — represent as needs_configuration, never guess. */
  mesureApplicable: boolean;
}

const RAM_STAFFING_MATRIX: Record<RamDestinationCategory, { standard: RamRoleCounts; dreamliner: RamRoleCounts }> = {
  Africa: {
    standard: { gate: 1, boarding: 1, profiling: null, mesureApplicable: false },
    dreamliner: { gate: 2, boarding: 2, profiling: null, mesureApplicable: false },
  },
  "Europe/Schengen": {
    standard: { gate: 1, boarding: 1, profiling: 1, mesureApplicable: false },
    dreamliner: { gate: 2, boarding: 2, profiling: 2, mesureApplicable: false },
  },
  "UK/USA": {
    standard: { gate: 1, boarding: 1, profiling: 1, mesureApplicable: true },
    dreamliner: { gate: 2, boarding: 2, profiling: 2, mesureApplicable: true },
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
 * Looks up the established role counts for a (destinationCategory, aircraft)
 * pair. Returns null when there's no rule at all yet for this category —
 * the caller's job to surface as needs_configuration, never to guess.
 */
export function getRamRoleCounts(destinationCategory: string | null, aircraft: string): RamRoleCounts | null {
  if (!destinationCategory) return null;
  const bucket = RAM_STAFFING_MATRIX[destinationCategory as RamDestinationCategory];
  if (!bucket) return null;
  return isDreamlinerAircraft(aircraft) ? bucket.dreamliner : bucket.standard;
}
