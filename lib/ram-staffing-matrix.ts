/**
 * The single, authoritative RAM (Atlas-managed) staffing matrix.
 *
 * CONFIRMED RULE (2026-10-04 revision, replacing the original "no rule
 * without a confirmed destination category" model): Gate and Boarding are
 * UNIVERSAL for every RAM-operated flight — driven by aircraft class ALONE
 * (standard vs Dreamliner), never by destination. A RAM flight ever showing
 * "needs configuration" for Gate/Boarding was a gap in a destination
 * CLASSIFICATION table, not a genuine missing staffing rule — RAM operates
 * every one of its own flights and always sends Gate/Boarding agents,
 * wherever it flies. "No requirement generated" is now reserved for what
 * it actually means: a SELF-MANAGED (foreign carrier) flight with no
 * confirmed company staffing config — see lib/company-config.ts.
 *
 * Profiling and Mesure remain genuinely destination-gated, unchanged from
 * before: CONFIRMED only for Europe/Schengen, UK/USA, and Canada (Profiling),
 * and UK/USA and Canada (Mesure) — see getRamProfilingCount/
 * getRamMesureHeadcount below. Every other destination (Africa, Domestic,
 * or any destination with no confirmed classification at all — Turkey,
 * the Gulf states, etc.) simply has no Profiling/Mesure requirement, which
 * is a confirmed "not applicable" answer, not a gap.
 *
 * This is the one place these numbers live; lib/operation-rules.ts
 * (Gate/Boarding) and lib/planning/specialized-demand.ts (Profiling/Mesure)
 * both read from it instead of keeping their own parallel copies, so the
 * "same flight → same rule everywhere" guarantee holds by construction.
 */

export type RamDestinationCategory = "Africa" | "Europe/Schengen" | "UK/USA" | "Canada";

export interface RamAircraftClassCounts {
  gate: number;
  boarding: number;
  /** null = Profiling does not apply to this destination category at all — not a gap, just not relevant. */
  profiling: number | null;
}

/**
 * Gate and Boarding — CONFIRMED universal for every RAM flight, aircraft-
 * class-driven only. 1 Gate + 1 Boarding for a standard (Embraer/737-type)
 * aircraft, 2 + 2 for a Dreamliner (787) — regardless of destination.
 */
const UNIVERSAL_GATE_BOARDING: Record<"standard" | "dreamliner", { gate: number; boarding: number }> = {
  standard: { gate: 1, boarding: 1 },
  dreamliner: { gate: 2, boarding: 2 },
};

/**
 * Profiling — CONFIRMED only for these three destination categories,
 * aircraft-class-driven the same way Gate/Boarding is. Canada is kept as
 * its OWN category (not merged into "UK/USA") even though today's
 * confirmed numbers happen to match — see destination-classification.ts
 * for why: the two rules might diverge later and must never be coupled.
 */
const RAM_PROFILING_CATEGORIES: Partial<Record<RamDestinationCategory, { standard: number; dreamliner: number }>> = {
  "Europe/Schengen": { standard: 1, dreamliner: 2 },
  "UK/USA": { standard: 1, dreamliner: 2 },
  Canada: { standard: 1, dreamliner: 2 },
};

/**
 * Mesure — CONFIRMED at 4 agents per flight wherever it applies (Canada,
 * UK, USA), regardless of aircraft class — deliberately has no
 * standard/dreamliner split (see getRamMesureHeadcount's own doc comment).
 */
const RAM_MESURE_CATEGORIES: Partial<Record<RamDestinationCategory, number>> = {
  "UK/USA": 4,
  Canada: 4,
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
 * Looks up the Gate/Boarding/Profiling counts for a (destinationCategory,
 * aircraft) pair. Gate and Boarding are now UNIVERSAL (aircraft-class-driven
 * only) and always present — this never returns null any more; a RAM
 * flight with ANY destination (classified or not) still gets its
 * Gate/Boarding numbers. Profiling stays genuinely destination-gated: null
 * when the category isn't one of the three CONFIRMED Profiling categories
 * (including when destinationCategory itself is null/unclassified) — that
 * is a confirmed "not applicable" answer, not a gap.
 */
export function getRamRoleCounts(destinationCategory: string | null, aircraft: string): RamAircraftClassCounts {
  const dreamliner = isDreamlinerAircraft(aircraft);
  const { gate, boarding } = dreamliner ? UNIVERSAL_GATE_BOARDING.dreamliner : UNIVERSAL_GATE_BOARDING.standard;

  const profilingBucket = destinationCategory
    ? RAM_PROFILING_CATEGORIES[destinationCategory as RamDestinationCategory]
    : undefined;
  const profiling = profilingBucket ? (dreamliner ? profilingBucket.dreamliner : profilingBucket.standard) : null;

  return { gate, boarding, profiling };
}

/**
 * Looks up the confirmed Mesure headcount for a destination category —
 * deliberately takes NO aircraft parameter, since Mesure is destination-
 * driven only (never aircraft-driven; see the module comment above).
 * Returns null when Mesure doesn't apply to this category at all (including
 * when the category is null/unclassified) — a confirmed "not applicable"
 * answer, not a gap; Gate/Boarding is unaffected either way (see
 * getRamRoleCounts above).
 */
export function getRamMesureHeadcount(destinationCategory: string | null): number | null {
  if (!destinationCategory) return null;
  return RAM_MESURE_CATEGORIES[destinationCategory as RamDestinationCategory] ?? null;
}
