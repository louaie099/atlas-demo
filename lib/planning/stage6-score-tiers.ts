/**
 * STAGE-6 CANDIDATE SCORE — THE EPSILON-NESTED PRIORITY HIERARCHY
 * (2026-09-24, fatigue-aware roster planning milestone, part 1).
 *
 * Stage 6 (shift-generation.ts's generateFlexiblePoolShifts) is a greedy
 * set-cover: every iteration it picks the single (employee, legal shift
 * code) candidate with the highest numeric `score`. Several signals of
 * DIFFERENT business priority are folded into that one number. They must
 * never trade off against each other — a lower tier may only ever break
 * a tie left by every higher tier. This module is the single, centralized
 * place those tiers and their magnitudes live, so each future tier is
 * sized against the others in ONE place instead of as inline coefficients
 * scattered through planning logic (the same "centralize the coefficient,
 * document it, never bury it" convention lib/fairness-config.ts
 * established).
 *
 * The business priority order (confirmed by the product owner's audit):
 *
 *   0. HARD LEGALITY — 15h rest, qualification, population filters.
 *      NOT part of the score at all: an illegal candidate is never
 *      scored (shift-generation.ts filters legal codes BEFORE scoring).
 *      No tier below can ever make an illegal candidate eligible.
 *   1. HARD COVERAGE — one unit (HARD_COVERAGE_UNIT = 1) per real,
 *      still-unfilled (30-min bucket, role) demand unit this candidate
 *      would cover.
 *   2. REQUIRED-COVERAGE REFINEMENT (T1 aggregate Check-in demand) —
 *      T1_DEMAND_BIAS_WEIGHT per residual T1 bucket covered. Part of the
 *      "required coverage" tier in business terms, so it sits directly
 *      under hard coverage and ABOVE roster structure.
 *   3. NORMAL ROSTER STRUCTURE (consecutive OFF/OFF) —
 *      OFF_WINDOW_STRUCTURE_CONFLICT_WEIGHT subtracted per STRUCTURAL
 *      CONFLICT (at most MAX_OFF_WINDOW_STRUCTURE_CONFLICTS = 3) between
 *      this candidate and the employee's pre-planned preferred OFF window
 *      for the week (lib/planning/off-window.ts): (a) today is inside the
 *      window; (b) the candidate code starts so early that NO catalog code
 *      on the previous day could be rest-legal before it, so it would force
 *      the previous day OFF although that day is outside the window;
 *      (c) the mirror image for a code ending so late it forces the next
 *      day OFF outside the window. (b)/(c) are what actually produced most
 *      residual separated OFF days on seed data: e.g. MT02 (04:30 start
 *      pre-regime) placed on a Wednesday for someone whose window is
 *      Thu–Fri silently forces Tuesday OFF, since no code ends early enough
 *      for 15h rest before 04:30.
 *   4. FATIGUE BURDEN — NOT WIRED YET (next phase). Its whole per-
 *      candidate-per-day contribution is RESERVED to stay strictly below
 *      FATIGUE_TIER_BUDGET (see lib/fatigue-config.ts and
 *      lib/planning/fatigue-model.ts, which exist but are not consulted by
 *      Stage 6 today).
 *   5. FAIRNESS / OTHER SOFT PREFERENCES — not in the numeric score at
 *      all: shift-generation.ts's lexicographic isBetterCandidate tie-break
 *      chain (shortest duration, fewest hours so far, continuity, id) only
 *      runs when scores are exactly equal, so it is automatically below
 *      every numeric tier above.
 *
 * WHY THE MAGNITUDES PROVE THE ORDER (each tier's MAXIMUM TOTAL
 * contribution for one candidate on one day is strictly less than the
 * SMALLEST non-zero difference the tier above it can produce):
 *
 *   - Tier 2 max total = STAGE6_BUCKETS_PER_DAY * T1_DEMAND_BIAS_WEIGHT
 *     = 48 * 0.001 = 0.048 < 1 = one hard-coverage unit.
 *   - Tier 3 max total = MAX_OFF_WINDOW_STRUCTURE_CONFLICTS *
 *     OFF_WINDOW_STRUCTURE_CONFLICT_WEIGHT = 3 * 0.00003 = 0.00009
 *     < 0.001 = one T1 bucket.
 *   - Tier 4 budget = FATIGUE_TIER_BUDGET = 0.00001 < 0.00003 = one
 *     structural conflict (the smallest non-zero tier-3 difference). A
 *     future fatigue term must be scaled so its TOTAL per-candidate-per-
 *     day contribution stays in [0, FATIGUE_TIER_BUDGET).
 *
 * Consequences, each pinned by tests/stage6-off-window-bias.test.ts:
 *   - A candidate covering strictly more hard demand ALWAYS wins, however
 *     much T1 demand, OFF/OFF structure (or future fatigue) favours the
 *     other one.
 *   - Among equal hard coverage, one more T1 bucket ALWAYS wins over
 *     better OFF/OFF structure (required coverage > roster structure).
 *   - The full structure penalty (<= 0.00009) is smaller than the smallest positive
 *     coverage score (one T1 bucket = 0.001), so a candidate that covers
 *     anything at all can never be pushed to score <= 0 and silently
 *     dropped by the structure term — the penalty can only REORDER
 *     candidates that each cover something, never delete coverage.
 *
 * Floating point: every score is computed by the same expression
 * (stage6CandidateScore below) from small non-negative integers, and any
 * two mathematically different scores differ by at least 1e-4 (well above
 * double rounding error at these magnitudes), so the strict `>` / `!==`
 * comparisons Stage 6 uses are exact in practice.
 */

/** Stage 6's 30-min demand grid — 48 buckets per day. Mirrors shift-generation.ts/demand-aggregation.ts. */
export const STAGE6_BUCKETS_PER_DAY = 48;

/** Tier 1 — value of covering one real unfilled (bucket, role) hard demand unit. */
export const HARD_COVERAGE_UNIT = 1;

/**
 * Tier 2 — per residual T1 aggregate Check-in demand bucket covered (moved
 * here unchanged from shift-generation.ts, 2026-09-23 value). See
 * shift-generation.ts's own doc comment on `t1DemandByBucket`.
 */
export const T1_DEMAND_BIAS_WEIGHT = 0.001;

/**
 * Tier 3 — penalty per structural conflict with the candidate employee's
 * preferred consecutive OFF window (see the hierarchy comment above for
 * the three conflict kinds). Confirmed business preference (consecutive
 * OFF/OFF is the normal roster shape), so — unlike lib/fairness-config.ts's
 * unconfirmed weights — it is ON by default; OFF_WINDOW_STRUCTURE_BIAS_ENABLED
 * below is the single switch that turns the whole mechanism off.
 */
export const OFF_WINDOW_STRUCTURE_CONFLICT_WEIGHT = 0.00003;

/** Tier 3 — conflicts counted per candidate per day are clamped to this, bounding the tier's total. */
export const MAX_OFF_WINDOW_STRUCTURE_CONFLICTS = 3;

/** Tier 3's maximum total contribution per candidate per day (0.00009). */
export const OFF_WINDOW_STRUCTURE_MAX_TOTAL = OFF_WINDOW_STRUCTURE_CONFLICT_WEIGHT * MAX_OFF_WINDOW_STRUCTURE_CONFLICTS;

/**
 * Tier 4 — RESERVED budget for the next phase's fatigue term. Not used by
 * any code today. A fatigue contribution wired into Stage 6 must be
 * scaled into [0, FATIGUE_TIER_BUDGET) per candidate per day.
 */
export const FATIGUE_TIER_BUDGET = 0.00001;

/**
 * Master switch for Part A's OFF/OFF structural bias. When false,
 * generate-draft-plan.ts computes no preferred OFF windows at all, so
 * Stage 6 scores exactly as it did before this milestone and Stage 6.5's
 * top-up falls back to its original earliest-start tie-break.
 */
export const OFF_WINDOW_STRUCTURE_BIAS_ENABLED = true;

/** Tiers 1+2 only — "does this candidate cover anything at all?" (0 means: skip it). */
export function stage6CoverageScore(hardBuckets: number, t1Buckets: number): number {
  return hardBuckets * HARD_COVERAGE_UNIT + t1Buckets * T1_DEMAND_BIAS_WEIGHT;
}

/**
 * The full Stage-6 candidate score (tiers 1-3). Returns 0 when the
 * candidate covers nothing — the structure tier is never applied to a
 * non-covering candidate, so it can never turn "no coverage" into a
 * selectable (or negative) score. `structureConflicts` is clamped to
 * [0, MAX_OFF_WINDOW_STRUCTURE_CONFLICTS].
 */
export function stage6CandidateScore(hardBuckets: number, t1Buckets: number, structureConflicts: number): number {
  const coverage = stage6CoverageScore(hardBuckets, t1Buckets);
  if (coverage === 0) return 0;
  const conflicts = Math.max(0, Math.min(MAX_OFF_WINDOW_STRUCTURE_CONFLICTS, Math.floor(structureConflicts)));
  return coverage - conflicts * OFF_WINDOW_STRUCTURE_CONFLICT_WEIGHT;
}
