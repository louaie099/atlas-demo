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
 * concern, so it does not appear as a weight here; (4) TASK-COUNT
 * fairness (taskCountWeight below) — RAM Handling has explicitly
 * confirmed this one, for the demo: distribute comparable tasks/duties
 * for the same shift/time period evenly across equally-eligible
 * candidates (e.g. 8 comparable tasks across 4 equally-eligible agents
 * should land ~2/2/2/2, not 5/2/1/0), purely as a soft tie-break among
 * candidates the hard gates already consider equally suitable — never at
 * the cost of coverage or any constraint; (4b) workload/undesirable-shift
 * distribution, using HOURS (workloadHoursWeight below) rather than raw
 * duty count, per the business's own acknowledgment that a longer/harder
 * task shouldn't count the same as a short one — this remains an
 * unconfirmed placeholder at weight 0 until a real burden model backs it
 * (task count is the confirmed, wanted interim proxy for the demo); (5)
 * other soft preferences (continuity, shift duration — already handled
 * elsewhere, e.g. shift-generation.ts's own tie-break chain, untouched by
 * this file).
 *
 * FATIGUE BURDEN — A SEPARATE DIMENSION (2026-09-24, fatigue milestone
 * part 2). `fatigueWeight` below is NOT folded into workloadHoursWeight and
 * the two are never summed into one number: the business asked for
 * workload HOURS and fatigue BURDEN (circadian/early/night/late/transition
 * pattern load — lib/planning/fatigue-model.ts) to stay distinct. Both are
 * secondary sort keys WITHIN the "recommended" group only, combined in a
 * fixed lexicographic order:
 *
 *   (4a) workload hours  — when workloadHoursWeight > 0: fewer scheduled
 *        hours this window first;
 *   (4b) fatigue burden  — when fatigueWeight > 0 AND the caller supplies
 *        an ENABLED fatigue input: lower recent accumulated burden first
 *        (an unknown history ranks as a neutral 0, never penalized);
 *   then the input pool's own order (Array.prototype.sort is stable).
 *
 * Hours comes first deliberately: it is the dimension that already
 * shipped, so switching fatigue on can only break ties hours leaves — it
 * never reorders a pair the existing hours signal already distinguishes
 * (a strictly additive rollout). With workloadHoursWeight at 0 (today's
 * default), fatigue is the only secondary key. (Stage 6's own numeric
 * hierarchy places fatigue ABOVE its hours-so-far tie-break — that tie-
 * break is an internal load-spreading heuristic of shift generation, not
 * this business-confirmed workload-fairness dimension; see
 * lib/planning/stage6-score-tiers.ts.) Neither key ever excludes,
 * downgrades or flags a candidate, and neither can move a "flagged"
 * candidate relative to a "recommended" one.
 *
 * TASK-COUNT fairness (taskCountWeight, 2026-10-03 demo milestone) sits
 * AHEAD of both of the above in the sort (key (4), before hours/fatigue's
 * (4a)/(4b)) — see scoreCandidates' own doc comment for exactly where.
 * Unlike workloadHoursWeight/fatigueWeight, this one defaults ON
 * (taskCountWeight: 1) because the business has explicitly confirmed raw
 * task-count distribution as real, wanted behavior for the demo, while
 * hours/fatigue remain unconfirmed placeholders pending a real burden
 * model. Same guarantees as the other two: a pure tie-break within the
 * "recommended" group only, never an exclusion, and never able to move a
 * "flagged" candidate ahead of a "recommended" one.
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
  // FATIGUE BURDEN dimension (see the doc comment above) — 0 / absent (the
  // default) is a genuine no-op. Optional so every persisted
  // config_snapshot written before this field existed still parses and
  // behaves exactly as before. A positive value turns on key (4b): lower
  // recent fatigue burden first, within the recommended group, after the
  // workload-hours key. As with workloadHoursWeight, only "> 0" carries
  // meaning today; relative magnitudes are NOT used to reorder the keys.
  // Requires the caller to pass scoreCandidates' `fatigue` input with an
  // enabled config (FATIGUE_MODEL_ENABLED stays false by default).
  fatigueWeight?: number;
  // TASK-COUNT fairness (see the doc comment above) — defaults to 1
  // (ENABLED), unlike the two weights above: RAM Handling confirmed raw
  // comparable-task-count distribution as the wanted demo behavior, so
  // this is the one real soft objective here rather than an unconfirmed
  // placeholder. A positive value turns on key (4): among otherwise
  // equally-suitable "recommended" candidates, prefer fewer comparable
  // tasks already assigned this scope (see scoreCandidates'
  // `tasksAssignedThisScope` parameter) — evaluated BEFORE the
  // hours/fatigue keys below it. Optional so every persisted
  // config_snapshot written before this field existed still parses — and
  // for those old snapshots, `?? 0` makes the missing field behave as
  // "count-fairness off", preserving exactly the order that snapshot was
  // generated under. As with the other weights, only "> 0" carries
  // meaning; relative magnitude is not used to reorder keys.
  taskCountWeight?: number;
}

export const DEFAULT_FAIRNESS_WEIGHTS: FairnessWeights = {
  workloadHoursWeight: 0,
  fatigueWeight: 0,
  taskCountWeight: 1,
};
