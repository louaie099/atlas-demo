/**
 * Fairness/workload weighting for scoreCandidates' soft tie-break (see
 * lib/scoring.ts). This is deliberately NOT a LaborRules entry
 * (lib/labor-rules.ts) — it's not a human-protection feasibility gate,
 * it's a soft preference among already-eligible candidates — but it
 * follows the exact same convention that codebase established for a
 * reason: don't invent a numeric business-rule coefficient (a fatigue
 * score, a night-shift multiplier, a historical-workload decay factor)
 * just because the underlying signal (hours) is easy to compute. Every
 * weight here defaults to a NEUTRAL/NO-OP value, matching
 * `unconfirmed_prototype` in spirit — until RAM Handling confirms a real
 * weighting, scoring must keep producing exactly the candidate order it
 * does today.
 *
 * Priority order this weighting sits within (see scoreCandidates' own doc
 * comment for the full chain): (1) hard constraints — unchanged, never
 * weighted away; (2) operational coverage — status recommended/flagged,
 * unchanged; (3) the working-hours OBLIGATION, once configured (see
 * lib/planning/roster-obligation.ts) — that's a roster-GENERATION
 * concern (Stage 6/7, WHICH days someone works), not a duty-scoring
 * concern, so it does not appear as a weight here; (4) workload/
 * undesirable-shift distribution, using HOURS (workloadHoursWeight
 * below) rather than raw duty count, per the explicit instruction that a
 * fairness signal should reflect actual scheduled time, not how many
 * discrete duties happened to be split up; (5) other soft preferences
 * (continuity, shift duration — already handled elsewhere, e.g.
 * shift-generation.ts's own tie-break chain, untouched by this file).
 */
export interface FairnessWeights {
  // 0 (the default) is a genuine no-op: scoreCandidates' sort is stable,
  // so with this at 0 the "recommended" group keeps EXACTLY the order it
  // already had (the input pool's own order) — byte-for-byte identical to
  // today's behavior. A positive value turns on a secondary sort, within
  // the recommended group only, preferring the candidate with FEWER
  // hours already scheduled this window (see scoreCandidates'
  // `hoursScheduledThisWindow` parameter) — lower-hours-first. The
  // magnitude beyond "> 0" carries no meaning yet (there is nothing else
  // to weight it against here); it exists as a number rather than a
  // boolean only so a future second, currently-unconfirmed soft signal
  // can be combined with it via relative magnitude without another
  // breaking config-shape change.
  workloadHoursWeight: number;
}

export const DEFAULT_FAIRNESS_WEIGHTS: FairnessWeights = {
  workloadHoursWeight: 0,
};
