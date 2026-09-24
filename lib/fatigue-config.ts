/**
 * Fatigue-burden model configuration (2026-09-24, fatigue-aware roster
 * planning milestone, part 1 — "Part B"). Consumed ONLY by
 * lib/planning/fatigue-model.ts and lib/planning/fatigue-continuity.ts.
 *
 * WIRED, BUT OFF BY DEFAULT (part 2, 2026-09-24). Stage 6 (tier 4 of
 * lib/planning/stage6-score-tiers.ts, strictly inside FATIGUE_TIER_BUDGET:
 * below hard coverage, T1 coverage refinement AND consecutive OFF/OFF
 * structure, above only the lexicographic fairness tie-breaks), the
 * Stage-6.5 top-up, the foreign-company roster and scoreCandidates'
 * `fatigueWeight` dimension all consume the model — but ONLY through a
 * FatigueConfig explicitly passed by the caller
 * (lib/planning/fatigue-planning.ts). No planner module imports
 * FATIGUE_MODEL_ENABLED / DEFAULT_FATIGUE_CONFIG to switch itself on, and
 * FATIGUE_MODEL_ENABLED stays false: real plans are unaffected until a
 * future phase consciously enables it (tests build their own enabled
 * config, e.g. PROTOTYPE_FATIGUE_CONFIG).
 *
 * Follows lib/fairness-config.ts's convention deliberately:
 *   - centralized: every coefficient and threshold the model uses lives
 *     here, never inline in planning logic;
 *   - neutral/off by default: FATIGUE_MODEL_ENABLED is false, so
 *     DEFAULT_FATIGUE_CONFIG makes every fatigue function return exactly 0
 *     (and explainFatigueFactors return no reasons) — a true no-op until a
 *     later phase consciously turns it on;
 *   - individually zeroable: any single weight set to 0 removes exactly
 *     that component and nothing else (the model never reads a component's
 *     inputs when its weight is 0).
 *
 * DISCLAIMER — SYNTHETIC PROTOTYPE VALUES. Every number in
 * PROTOTYPE_FATIGUE_WEIGHTS and DEFAULT_FATIGUE_THRESHOLDS below is an
 * engineering placeholder chosen only so the model's SHAPE can be built and
 * tested (e.g. "an early start costs more than a daytime start", "two
 * consecutive OFF days recover more than one"). They are NOT validated
 * scientific fatigue coefficients, NOT derived from any biomathematical
 * fatigue model, and NOT confirmed by RAM Handling. They must not be
 * presented to anyone as a measure of an individual's fitness for duty;
 * this model describes operational WORKLOAD BURDEN patterns only.
 */

/** Master switch. false = every fatigue function is a no-op (returns 0 / no reasons). */
export const FATIGUE_MODEL_ENABLED = false;

export interface FatigueWeights {
  /** Per hour a shift starts before `thresholds.earlyStartBefore`. */
  earlyStartWeight: number;
  /** Per hour of the shift inside the night window [`nightWindowStart`, `nightWindowEnd`). */
  nightWorkWeight: number;
  /** Per hour a shift ends after `thresholds.lateFinishAfter` (capped at `lateFinishMaxHours`). */
  lateFinishWeight: number;
  /** Per `referenceDurationHours` of shift length (linear: an 8h shift = 1 x this weight). */
  durationWeight: number;
  /** Scales the bounded start-time-swing transition cost between consecutive worked days (never a legality check). */
  transitionWeight: number;
  /** Extra multiplier per additional CONSECUTIVE difficult day (compounding): day k of a run costs x(1 + w*(k-1)). */
  consecutiveDifficultShiftWeight: number;
  /** Fraction of accumulated burden recovered by one isolated OFF day (geometric decay). Clamped to `maxSingleDayRecoveryFraction`. */
  recoveryWeight: number;
  /**
   * TRANSPORT BURDEN — INTENTIONALLY INERT (0) pending a broader transport-
   * metadata dataset and confidence review. See the judgment call below.
   */
  transportBurdenWeight: number;
}

/**
 * TRANSPORT BURDEN — RELIABILITY JUDGMENT CALL (2026-09-24).
 *
 * lib/shift-templates.ts's TRANSPORT_METADATA was reviewed as it exists
 * today and judged NOT reliable or complete enough to drive a quantitative
 * burden number:
 *   - coverage: only 2 groupings (transportEquipeAF, transportRegions) and
 *     5 shift codes (JR02, MT02, MT03, AP03, AP04) — no data at all for the
 *     other 8 catalog codes, so any transport term would penalize only the
 *     codes that happen to be documented, not the ones that actually carry
 *     the most commute burden;
 *   - regime: values are GMT only (post-2026-09-20); there is nothing for
 *     the GMT+1 regime, so the same shift would carry different burden
 *     purely from data availability;
 *   - quality: the transportEquipeAF.sortie row's source date reads "2027"
 *     (flagged as a likely typo for 2026, unconfirmed), and that same row
 *     (15:15 for JR02/MT03) is EARLIER than JR02's own 16:45 sortie, i.e.
 *     internally inconsistent for JR02;
 *   - semantics: it is shuttle reporting/release time, explicitly NOT
 *     operational availability, and its relationship to real door-to-door
 *     commute time is unknown.
 * Conclusion: transportBurdenWeight defaults to 0 and stays 0. The
 * ARCHITECTURE is in place (fatigue-model.ts threads an optional
 * `transportContext` through computeShiftBurden and the breakdown, and
 * lookupTransportContext() exposes the metadata with explicit caveats) so a
 * future phase can enable it by supplying a vetted dataset and a confirmed
 * coefficient here — never by inventing one now. Transport metadata must
 * never feed eligibility, availability, rest or capacity.
 */
export const PROTOTYPE_FATIGUE_WEIGHTS: FatigueWeights = {
  earlyStartWeight: 1.0,
  nightWorkWeight: 1.0,
  lateFinishWeight: 0.5,
  durationWeight: 1.0,
  transitionWeight: 1.0,
  consecutiveDifficultShiftWeight: 0.25,
  recoveryWeight: 0.4,
  transportBurdenWeight: 0,
};

/** Thresholds and curve-shape parameters. Clock times are "HH:mm" minute-of-day in the shift's own resolved regime. */
export interface FatigueThresholds {
  /** A start strictly before this is an "early start" (costs earlyStartWeight per hour before it). */
  earlyStartBefore: string;
  /** A start strictly before this is a "very early start" (explanation labels / consecutive very-early counting). */
  veryEarlyStartBefore: string;
  /** Hours before `earlyStartBefore` beyond which the early-start cost stops growing. */
  earlyStartMaxHours: number;
  /** Night window start (may be before midnight). */
  nightWindowStart: string;
  /** Night window end (after midnight). */
  nightWindowEnd: string;
  /** A finish strictly after this (on the shift's own timeline, may run past midnight) is a "late finish". */
  lateFinishAfter: string;
  /** Hours after `lateFinishAfter` beyond which the late-finish cost stops growing. */
  lateFinishMaxHours: number;
  /** Shift length that counts as exactly one durationWeight unit. */
  referenceDurationHours: number;
  /** A worked day whose burden (before compounding) is >= this counts as a DIFFICULT day for consecutive compounding. */
  difficultDayBurdenThreshold: number;
  /** Start-time swing (circular, hours) between consecutive worked days that costs nothing. */
  transitionComfortableSwingHours: number;
  /** Multiplier applied to the swing cost when the next start is EARLIER in the day than the previous one (backward rotation). */
  transitionBackwardRotationFactor: number;
  /** Per intervening OFF day, the transition cost is multiplied by this (0..1). */
  transitionOffDayDamping: number;
  /** Upper bound on the fraction of accumulated burden any single OFF day can remove — one OFF day can never fully erase accumulated burden. */
  maxSingleDayRecoveryFraction: number;
  /** Extra recovery rate per additional CONSECUTIVE OFF day: day k of an OFF run recovers recoveryWeight * (1 + bonus*(k-1)), capped. */
  consecutiveOffRecoveryBonus: number;
  /** Differences in recent component load below this are treated as "no meaningful difference" by explainFatigueFactors. */
  explanationMinDifference: number;
}

export const DEFAULT_FATIGUE_THRESHOLDS: FatigueThresholds = {
  earlyStartBefore: "06:00",
  veryEarlyStartBefore: "05:00",
  earlyStartMaxHours: 3,
  nightWindowStart: "23:00",
  nightWindowEnd: "05:00",
  lateFinishAfter: "22:00",
  lateFinishMaxHours: 4,
  referenceDurationHours: 8,
  difficultDayBurdenThreshold: 2.0,
  transitionComfortableSwingHours: 2,
  transitionBackwardRotationFactor: 1.5,
  transitionOffDayDamping: 0.5,
  maxSingleDayRecoveryFraction: 0.75,
  consecutiveOffRecoveryBonus: 0.5,
  explanationMinDifference: 0.25,
};

export interface FatigueConfig {
  enabled: boolean;
  weights: FatigueWeights;
  thresholds: FatigueThresholds;
}

/** The default everywhere: disabled (true no-op) while FATIGUE_MODEL_ENABLED is false. */
export const DEFAULT_FATIGUE_CONFIG: FatigueConfig = {
  enabled: FATIGUE_MODEL_ENABLED,
  weights: PROTOTYPE_FATIGUE_WEIGHTS,
  thresholds: DEFAULT_FATIGUE_THRESHOLDS,
};

/**
 * The same synthetic prototype weights with the model switched ON — for
 * tests and for a future phase's explicit opt-in. Still carries
 * transportBurdenWeight = 0.
 */
export const PROTOTYPE_FATIGUE_CONFIG: FatigueConfig = {
  enabled: true,
  weights: PROTOTYPE_FATIGUE_WEIGHTS,
  thresholds: DEFAULT_FATIGUE_THRESHOLDS,
};
