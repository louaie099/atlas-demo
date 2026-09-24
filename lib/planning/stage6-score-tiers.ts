/**
 * STAGE-6 CANDIDATE SCORE — THE EPSILON-NESTED PRIORITY HIERARCHY
 * (2026-09-24, fatigue-aware roster planning milestone, part 1; tier 4
 * wired in part 2).
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
 *   4. FATIGUE BURDEN — WIRED (2026-09-24, part 2), INERT BY DEFAULT.
 *      Only active when Stage 6 is handed a Stage6FatigueContext whose
 *      config is enabled (lib/planning/fatigue-planning.ts);
 *      FATIGUE_MODEL_ENABLED (lib/fatigue-config.ts) stays false, so no
 *      real plan uses it yet. Formula, per (employee, candidate code, day):
 *
 *        resultingBurden = accumulateFatigue(stateEnteringToday,
 *                            dayBurden(code, realDate) + transition from
 *                            the employee's last worked shift
 *                          ).accumulatedBurden
 *        fatigueSteps    = clamp(round(resultingBurden /
 *                            FATIGUE_BURDEN_PER_STEP), 0, MAX_FATIGUE_SCORE_STEPS)
 *        tier-4 term     = - fatigueSteps * FATIGUE_SCORE_STEP
 *
 *      i.e. one score step (1e-9) per 0.01 units of resulting accumulated
 *      burden, saturating at 99.99 burden units (far above any realistic
 *      one-week accumulation under the prototype weights). LOWER resulting
 *      burden = smaller penalty = preferred. Because the resulting burden
 *      includes the employee's accumulated state, this both prefers the
 *      less-loaded EMPLOYEE for the same code (Agent B over Agent A) and
 *      the less burdensome legal CODE for the same employee.
 *      Integer steps (never a raw float) keep the same exact-comparison
 *      discipline as tier 3: any two mathematically different scores still
 *      differ by a representable amount (see "Floating point" below).
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
 *     structural conflict (the smallest non-zero tier-3 difference). The
 *     wired fatigue term's TOTAL per-candidate-per-day contribution is
 *     MAX_FATIGUE_SCORE_STEPS * FATIGUE_SCORE_STEP = 9999 * 1e-9
 *     = 0.000009999 = FATIGUE_SCORE_MAX_TOTAL, inside [0, FATIGUE_TIER_BUDGET).
 *   - Tiers 3+4 together (<= 0.00009 + 0.000009999) are still < 0.001 =
 *     one T1 bucket, so a covering candidate's score stays > 0: fatigue
 *     can never turn a covering candidate into a non-candidate.
 *
 * Consequences, each pinned by tests/stage6-off-window-bias.test.ts:
 *   - A candidate covering strictly more hard demand ALWAYS wins, however
 *     much T1 demand, OFF/OFF structure or fatigue favours the other one.
 *   - One fewer structural conflict ALWAYS wins over any fatigue
 *     difference (tests/stage6-fatigue-wiring.test.ts pins the tier-4
 *     half of these invariants).
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
 * two mathematically different scores differ by at least 1e-9 (one
 * fatigue step; 1e-4-ish when the fatigue tier is inactive). Scores are
 * bounded by ~48 (at most one hard unit per bucket), where a double's
 * spacing is ~7e-15 — five orders of magnitude below 1e-9 — so the strict
 * `>` / `!==` comparisons Stage 6 uses are exact in practice. With
 * fatigueSteps = 0 (the default) the expression subtracts exactly 0 and
 * the score is bit-identical to the pre-fatigue formula.
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
 * Tier 4 — budget for the fatigue term. A fatigue contribution wired into
 * Stage 6 must be scaled into [0, FATIGUE_TIER_BUDGET) per candidate per
 * day; the constants below do exactly that.
 */
export const FATIGUE_TIER_BUDGET = 0.00001;

/** Tier 4 — score value of one fatigue step (see the hierarchy comment). */
export const FATIGUE_SCORE_STEP = 1e-9;

/** Tier 4 — resulting accumulated-burden units represented by one step. */
export const FATIGUE_BURDEN_PER_STEP = 0.01;

/** Tier 4 — steps are clamped to this, bounding the tier's total strictly below FATIGUE_TIER_BUDGET. */
export const MAX_FATIGUE_SCORE_STEPS = 9999;

/** Tier 4's maximum total contribution per candidate per day (0.000009999 < FATIGUE_TIER_BUDGET). */
export const FATIGUE_SCORE_MAX_TOTAL = MAX_FATIGUE_SCORE_STEPS * FATIGUE_SCORE_STEP;

/**
 * Quantizes a candidate's RESULTING accumulated burden (fatigue-planning.ts's
 * projectFatigueForShift(...).after.accumulatedBurden) into integer tier-4
 * steps: round(burden / FATIGUE_BURDEN_PER_STEP), clamped to
 * [0, MAX_FATIGUE_SCORE_STEPS]. Non-finite or non-positive input -> 0.
 */
export function fatigueScoreSteps(resultingBurden: number): number {
  if (!Number.isFinite(resultingBurden) || resultingBurden <= 0) return 0;
  return Math.min(MAX_FATIGUE_SCORE_STEPS, Math.round(resultingBurden / FATIGUE_BURDEN_PER_STEP));
}

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
 * The full Stage-6 candidate score (tiers 1-4). Returns 0 when the
 * candidate covers nothing — neither the structure tier nor the fatigue
 * tier is ever applied to a non-covering candidate, so they can never turn
 * "no coverage" into a selectable (or negative) score.
 * `structureConflicts` is clamped to [0, MAX_OFF_WINDOW_STRUCTURE_CONFLICTS];
 * `fatigueSteps` (from fatigueScoreSteps; default 0 = fatigue tier
 * inactive, bit-identical to the tiers 1-3 formula) is clamped to
 * [0, MAX_FATIGUE_SCORE_STEPS].
 */
export function stage6CandidateScore(hardBuckets: number, t1Buckets: number, structureConflicts: number, fatigueSteps = 0): number {
  const coverage = stage6CoverageScore(hardBuckets, t1Buckets);
  if (coverage === 0) return 0;
  const conflicts = Math.max(0, Math.min(MAX_OFF_WINDOW_STRUCTURE_CONFLICTS, Math.floor(structureConflicts)));
  const steps = Number.isFinite(fatigueSteps) ? Math.max(0, Math.min(MAX_FATIGUE_SCORE_STEPS, Math.floor(fatigueSteps))) : 0;
  return coverage - conflicts * OFF_WINDOW_STRUCTURE_CONFLICT_WEIGHT - steps * FATIGUE_SCORE_STEP;
}
