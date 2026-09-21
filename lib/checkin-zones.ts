import { DESTINATIONS } from "./destination-classification";

/**
 * T1 Check-in ZONE taxonomy — a genuinely different concept from
 * `destination_category` (lib/destination-classification.ts's RAM
 * operational category, used for Gate/Boarding/Profiling/Mesure). RAM does
 * NOT staff Check-in per flight in reality: agents work a shared zone/
 * counter range and process passengers from whatever flights currently
 * have Check-in open in that zone. This module is the "which T1 zone does
 * this flight's Check-in use" step of the pipeline described by the
 * product owner:
 *
 *   RAM flight program -> which T1 zone each flight uses -> which flights
 *   currently have Check-in open -> combined workload in that zone ->
 *   required T1 Check-in workforce -> agents assigned to the zone/counters.
 *
 * CONFIRMED (from the product owner, a real CMN Check-in/Boarding agent):
 *  - The six zones below exist, with the stated purposes.
 *  - Counter ranges are as given, INCLUDING the two overlaps at 76 (Main
 *    30-76 vs Business 76-86) and at 26 (Domestic 20-26 vs Staff 26-30).
 *    The product owner explicitly said not to silently resolve these —
 *    they are modeled here as literal, possibly-overlapping configurable
 *    values (see CHECKIN_ZONES' `counters` field and its doc comment),
 *    never picked apart into a guessed non-overlapping split.
 *  - Italy/Spain routes from destination/IATA data only, never flight
 *    number.
 *
 * UNCONFIRMED / CONFIGURABLE (following lib/labor-rules.ts's
 * `RuleValue<T>`/`LaborRuleSource` convention, since these are exactly the
 * same kind of "real policy lever, no confirmed number yet" fact):
 *  - The exact counter boundary at 76 and at 26 (which zone "owns" the
 *    shared counter).
 *  - Whether a zone's counter range is contiguous in practice or itself
 *    subdivided operationally.
 */
export type CheckinZoneId =
  | "t1_main_checkin"
  | "t1_business_checkin"
  | "t1_italy_spain"
  | "t1_domestic"
  | "t1_staff_checkin"
  | "t1_oversized_baggage";

/**
 * Which zones get an automatic, aggregate-demand-driven headcount today
 * (see lib/planning/checkin-zone-demand.ts). Business Check-in, Staff
 * Check-in, and Oversized Baggage EXIST in the data model (every zone in
 * CHECKIN_ZONES is a real, addressable zone with counters, eligible for
 * manual zone-requirement rows and zone assignments) but have NO invented
 * automatic staffing formula — per the explicit instruction not to
 * fabricate a coefficient "for completeness." `"automatic"` zones use the
 * prototype per-zone demand policy; `"manual"` zones only ever get a
 * zone requirement if a human/config creates one directly (headcount 0
 * from the automatic engine).
 */
export type CheckinZoneDemandMode = "automatic" | "manual";

export interface CheckinZoneCounterRange {
  /** First counter number in the range, inclusive. */
  from: number;
  /** Last counter number in the range, inclusive. */
  to: number;
}

export interface CheckinZoneDefinition {
  id: CheckinZoneId;
  /** Display name for Flight Coverage / Agent Schedule, e.g. "T1 Main Check-in". */
  label: string;
  floor: "Upper floor" | "Floor 0" | "Staff area" | "Special";
  counters: CheckinZoneCounterRange;
  /**
   * Human-readable counter-range label for display, e.g. "counters 30–76".
   * Kept as a separate field (not derived) because Oversized Baggage is "one
   * dedicated special counter/function," not a numeric range — the product
   * owner's own phrasing, not invented.
   */
  countersLabel: string;
  description: string;
  demandMode: CheckinZoneDemandMode;
  /**
   * Set only for a zone whose counter boundary is EXPLICITLY flagged by the
   * product owner as overlapping an adjacent zone's range and NOT to be
   * silently resolved (Main/Business at 76, Domestic/Staff at 26). Every
   * other zone has this unset — its own range is unambiguous.
   */
  overlapsWith?: { zone: CheckinZoneId; atCounter: number; note: string };
}

/**
 * CONFIRMED zone list and PURPOSE per the product owner's brief; counter
 * numbers themselves are UNCONFIRMED/configurable literal values (see the
 * module doc comment) — do not read `counters`/`countersLabel` as verified
 * RAM facility measurements, only as the shape ATLAS currently models.
 */
export const CHECKIN_ZONES: Record<CheckinZoneId, CheckinZoneDefinition> = {
  t1_main_checkin: {
    id: "t1_main_checkin",
    label: "T1 Main Check-in",
    floor: "Upper floor",
    counters: { from: 30, to: 76 },
    countersLabel: "counters 30–76",
    description:
      "Main international RAM Check-in (Europe, Asia, Africa, USA, Canada) EXCEPT Italy/Spain (t1_italy_spain) and Business-class (t1_business_checkin).",
    demandMode: "automatic",
    overlapsWith: {
      zone: "t1_business_checkin",
      atCounter: 76,
      note:
        "Product owner flagged: counter 76 is stated as the boundary of BOTH Main (30–76) and Business (76–86). NOT resolved to a single owner — modeled as a literal overlap pending confirmation.",
    },
  },
  t1_business_checkin: {
    id: "t1_business_checkin",
    label: "T1 Business Check-in",
    floor: "Upper floor",
    counters: { from: 76, to: 86 },
    countersLabel: "counters 76–86",
    description: "Dedicated Business-class Check-in.",
    demandMode: "manual",
    overlapsWith: {
      zone: "t1_main_checkin",
      atCounter: 76,
      note: "See t1_main_checkin's overlapsWith note — same unresolved boundary, other side.",
    },
  },
  t1_italy_spain: {
    id: "t1_italy_spain",
    label: "T1 Italy/Spain Check-in",
    floor: "Floor 0",
    counters: { from: 1, to: 19 },
    countersLabel: "counters 1–19",
    description:
      "Dedicated to Italian and Spanish destinations, routed from destination/IATA data (see classifyCheckinZone below), never from flight number.",
    demandMode: "automatic",
  },
  t1_domestic: {
    id: "t1_domestic",
    label: "T1 Domestic Check-in",
    floor: "Floor 0",
    counters: { from: 20, to: 26 },
    countersLabel: "counters 20–26",
    description: "Domestic RAM Check-in.",
    demandMode: "automatic",
    overlapsWith: {
      zone: "t1_staff_checkin",
      atCounter: 26,
      note:
        "Product owner flagged: counter 26 is stated as the boundary of BOTH Domestic (20–26) and Staff Check-in (26–30). NOT resolved to a single owner — modeled as a literal overlap pending confirmation.",
    },
  },
  t1_staff_checkin: {
    id: "t1_staff_checkin",
    label: "T1 Staff Check-in",
    floor: "Staff area",
    counters: { from: 26, to: 30 },
    countersLabel: "counters 26–30",
    description: "Separate staff area.",
    demandMode: "manual",
    overlapsWith: {
      zone: "t1_domestic",
      atCounter: 26,
      note: "See t1_domestic's overlapsWith note — same unresolved boundary, other side.",
    },
  },
  t1_oversized_baggage: {
    id: "t1_oversized_baggage",
    label: "T1 Oversized Baggage",
    floor: "Special",
    counters: { from: 0, to: 0 }, // not a numeric range — see countersLabel
    countersLabel: "dedicated special counter/function",
    description: "One dedicated special counter/function for oversized baggage.",
    demandMode: "manual",
  },
};

export const CHECKIN_ZONE_IDS = Object.keys(CHECKIN_ZONES) as CheckinZoneId[];

/** Zones an ordinary Check-in-qualified ACE can be considered for today (see the module-level eligibility doc comment in checkin-zone-placement.ts). Business/Staff/Oversized are excluded from ORDINARY default placement — they are manual/config-driven zones, never a default idle-time landing spot, until a real policy for them is confirmed. */
export const ORDINARY_CHECKIN_ZONES: CheckinZoneId[] = ["t1_main_checkin", "t1_italy_spain", "t1_domestic"];

/**
 * Classifies which T1 Check-in zone a flight's Check-in operation uses,
 * from destination/IATA data ONLY (never flight number, per the explicit
 * instruction). This is a genuinely different classification axis from
 * `classifyDestinationOperationally` (destination-classification.ts) —
 * that function answers "what RAM operational category (Gate/Boarding/
 * Profiling security tier) does this destination fall under"; this one
 * answers "which physical T1 Check-in zone/counter range serves this
 * flight." Spain, for example, is "Europe/Schengen" for the first question
 * and "Italy/Spain zone" for the second — two unrelated facts about the
 * same destination, never conflated or merged into one lookup.
 *
 * Domestic (Morocco) flights route to t1_domestic; every other destination
 * routes to t1_main_checkin UNLESS it is Italy or Spain, in which case it
 * routes to t1_italy_spain. Business-class Check-in, Staff Check-in, and
 * Oversized Baggage are never a per-flight classification outcome — they
 * are separate operational concerns a flight's ordinary Check-in
 * classification never resolves to (see the module doc comment: they stay
 * manual/config-driven zones today).
 *
 * Returns null for a destination not in DESTINATIONS at all — genuinely
 * unclassifiable with what's currently confirmed, same convention as
 * classifyDestinationOperationally, never guessed.
 */
export function classifyCheckinZone(destinationCode: string | null): CheckinZoneId | null {
  if (!destinationCode) return null;
  const dest = DESTINATIONS[destinationCode];
  if (!dest) return null;
  if (dest.country === "Morocco") return "t1_domestic";
  if (dest.country === "Italy" || dest.country === "Spain") return "t1_italy_spain";
  return "t1_main_checkin";
}
