import { getShiftTimesAs, TRANSPORT_METADATA, resolveShiftRegime } from "../shift-templates";
import { DEFAULT_FATIGUE_CONFIG, FatigueConfig } from "../fatigue-config";

/**
 * CENTRALIZED FATIGUE-BURDEN MODEL CORE (2026-09-24, fatigue-aware roster
 * planning milestone, part 1 — "Part B").
 *
 * STATUS: ARCHITECTURE + PURE FUNCTIONS ONLY. Not consulted by Stage 6,
 * the Stage-6.5 top-up, or lib/scoring.ts yet — wiring is the next phase,
 * and must fit inside stage6-score-tiers.ts's FATIGUE_TIER_BUDGET.
 *
 * Vocabulary is deliberately operational, never medical: "burden",
 * "recent workload pattern", "recovery" (as in rest days). Nothing here
 * diagnoses or rates a person's fitness for duty, and every coefficient is
 * a synthetic prototype value from lib/fatigue-config.ts (see its
 * disclaimer).
 *
 * Every function is pure (no I/O, no clock, no randomness) and, when
 * `config.enabled` is false (the default — FATIGUE_MODEL_ENABLED), returns
 * a neutral zero result. Shift clock times are ALWAYS resolved through
 * getShiftTimesAs(code, date) for the real calendar date — never
 * SHIFT_CODES — because the 2026-09-20 GMT+1 -> GMT regime change makes a
 * code's real times date-dependent, and burden must track the real times.
 *
 * This module never returns anything shaped like a shift start/end or an
 * eligibility/availability flag: its outputs are burden numbers, named
 * breakdown components, classification booleans and human-readable
 * labels. Transport metadata in particular can only ever add burden (when
 * explicitly enabled) and never touches availability.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A shift identified the only correct way: code + the real calendar date it is worked on. */
export interface ShiftOnDate {
  code: string;
  date: string; // "YYYY-MM-DD"
}

/**
 * OPTIONAL transport burden input (INERT: transportBurdenWeight defaults to
 * 0 — see lib/fatigue-config.ts's reliability judgment). Extra unpaid
 * minutes a shuttle adds before the shift's start / after its end. A
 * future phase supplies this from a vetted dataset; today the only source
 * is lookupTransportContext() below, which carries explicit caveats.
 */
export interface TransportBurdenContext {
  extraMinutesBefore: number;
  extraMinutesAfter: number;
}

/**
 * Named components of one day's burden — the structured intermediate data a
 * later explanation UI can rank without re-deriving any math. All values
 * are >= 0 except recoveryCredit, which is the (positive) amount of
 * accumulated burden REMOVED by an OFF day.
 */
export interface FatigueBurdenBreakdown {
  earlyStartComponent: number;
  nightComponent: number;
  lateFinishComponent: number;
  durationComponent: number;
  transitionComponent: number;
  transportComponent: number;
  /** Extra cost added by compounding a run of consecutive difficult days (filled in by accumulateFatigue). */
  consecutiveDifficultComponent: number;
  /** Accumulated burden removed by an OFF day (filled in by accumulateFatigue). */
  recoveryCredit: number;
  /** Sum of the shift-level components (early+night+late+duration+transition+transport), before compounding. */
  dayBurden: number;
  /** Classification flags for explanations — NOT clock times. */
  isEarlyStart: boolean;
  isVeryEarlyStart: boolean;
  isNightWork: boolean;
  isLateFinish: boolean;
}

/** Where a fatigue state's starting point came from — mirrors rotation-context.ts's BoundaryContextProvenance, plus "unknown_start" for a state that began with no history at all. */
export type FatigueProvenance = "prior_plan" | "fallback_static_baseline" | "unknown_start";

/** Decayed recent load per component — what explanations compare between candidates. */
export interface RecentComponentLoad {
  early: number;
  night: number;
  lateFinish: number;
  duration: number;
  transition: number;
}

/** A KNOWN fatigue state: real (or explicitly approximate) history has been folded in. */
export interface FatigueState {
  known: true;
  provenance: FatigueProvenance;
  /** Carried burden: compounding work days add to it, OFF days decay it geometrically. */
  accumulatedBurden: number;
  consecutiveWorkDays: number;
  consecutiveOffDays: number;
  consecutiveDifficultDays: number;
  consecutiveVeryEarlyDays: number;
  recent: RecentComponentLoad;
  /** Breakdown of the most recent day folded in (null before any day). */
  lastDay: FatigueBurdenBreakdown | null;
  daysObserved: number;
}

/**
 * The honest "nothing known" state — NEVER a fabricated history. A caller
 * that cannot find a real predecessor plan (and has no acceptable
 * fallback) gets this, and accumulateFatigue starts from a neutral zero
 * baseline tagged provenance "unknown_start" rather than inventing a
 * plausible previous week.
 */
export interface UnknownFatigueState {
  known: false;
  reason: string;
}

export type FatigueStateOrUnknown = FatigueState | UnknownFatigueState;

export function unknownFatigueState(reason: string): UnknownFatigueState {
  return { known: false, reason };
}

/** A neutral, zero-burden KNOWN starting state with the given provenance. */
export function neutralFatigueState(provenance: FatigueProvenance): FatigueState {
  return {
    known: true,
    provenance,
    accumulatedBurden: 0,
    consecutiveWorkDays: 0,
    consecutiveOffDays: 0,
    consecutiveDifficultDays: 0,
    consecutiveVeryEarlyDays: 0,
    recent: { early: 0, night: 0, lateFinish: 0, duration: 0, transition: 0 },
    lastDay: null,
    daysObserved: 0,
  };
}

// ---------------------------------------------------------------------------
// Internals — resolved times on a single continuous timeline
// ---------------------------------------------------------------------------

function toMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/** Start/end in minutes from the shift day's midnight; end > start always (an overnight shift's end is on the next calendar day, i.e. > 1440). An internal burden-math representation — never a roster/eligibility field. */
export interface ResolvedSpan {
  startMin: number;
  endMin: number;
}

function resolveSpan(code: string, date: string): ResolvedSpan {
  const { shift_start, shift_end } = getShiftTimesAs(code, date);
  const startMin = toMin(shift_start);
  let endMin = toMin(shift_end);
  if (endMin <= startMin) endMin += 24 * 60; // overnight: real end is the following calendar day
  return { startMin, endMin };
}

/** Span from ALREADY date-resolved "HH:mm" times — for fatigue-continuity.ts, which obtains real times through rotation-context.ts's existing derivations (themselves resolved via getShiftTimesAs for the real date) rather than re-resolving codes. */
export function spanFromResolvedTimes(start: string, end: string): ResolvedSpan {
  const startMin = toMin(start);
  let endMin = toMin(end);
  if (endMin <= startMin) endMin += 24 * 60;
  return { startMin, endMin };
}

/** Minutes of [aStart, aEnd) overlapping the repeating daily window [wStart, wEnd) (window may wrap midnight), over the span's full extent. */
function overlapWithDailyWindow(span: ResolvedSpan, wStartMin: number, wEndMin: number): number {
  let total = 0;
  // A span is at most ~24h; check the window instances anchored on the previous, same and next day.
  for (let dayOffset = -1; dayOffset <= 1; dayOffset++) {
    const base = dayOffset * 24 * 60;
    const ws = base + wStartMin;
    const we = wEndMin > wStartMin ? base + wEndMin : base + 24 * 60 + wEndMin;
    total += Math.max(0, Math.min(span.endMin, we) - Math.max(span.startMin, ws));
  }
  return total;
}

function emptyBreakdown(): FatigueBurdenBreakdown {
  return {
    earlyStartComponent: 0,
    nightComponent: 0,
    lateFinishComponent: 0,
    durationComponent: 0,
    transitionComponent: 0,
    transportComponent: 0,
    consecutiveDifficultComponent: 0,
    recoveryCredit: 0,
    dayBurden: 0,
    isEarlyStart: false,
    isVeryEarlyStart: false,
    isNightWork: false,
    isLateFinish: false,
  };
}

/** Shift-level components for an already-resolved span. transitionComponent is left 0 (see computeDayBurdenBreakdown). */
export function shiftBurdenBreakdownForSpan(
  span: ResolvedSpan,
  config: FatigueConfig = DEFAULT_FATIGUE_CONFIG,
  transportContext?: TransportBurdenContext
): FatigueBurdenBreakdown {
  const b = emptyBreakdown();
  if (!config.enabled) return b;
  const { weights: w, thresholds: t } = config;

  const earlyThreshold = toMin(t.earlyStartBefore);
  const hoursEarly = Math.min(t.earlyStartMaxHours, Math.max(0, (earlyThreshold - span.startMin) / 60));
  b.isEarlyStart = hoursEarly > 0;
  b.isVeryEarlyStart = span.startMin < toMin(t.veryEarlyStartBefore);
  if (w.earlyStartWeight !== 0) b.earlyStartComponent = w.earlyStartWeight * hoursEarly;

  const nightHours = overlapWithDailyWindow(span, toMin(t.nightWindowStart), toMin(t.nightWindowEnd)) / 60;
  b.isNightWork = nightHours > 0;
  if (w.nightWorkWeight !== 0) b.nightComponent = w.nightWorkWeight * nightHours;

  const lateHours = Math.min(t.lateFinishMaxHours, Math.max(0, (span.endMin - toMin(t.lateFinishAfter)) / 60));
  b.isLateFinish = lateHours > 0;
  if (w.lateFinishWeight !== 0) b.lateFinishComponent = w.lateFinishWeight * lateHours;

  if (w.durationWeight !== 0) b.durationComponent = w.durationWeight * ((span.endMin - span.startMin) / 60 / t.referenceDurationHours);

  // INERT unless explicitly enabled — the context is not even read at weight 0.
  if (w.transportBurdenWeight !== 0 && transportContext) {
    const extraHours = (Math.max(0, transportContext.extraMinutesBefore) + Math.max(0, transportContext.extraMinutesAfter)) / 60;
    b.transportComponent = w.transportBurdenWeight * extraHours;
  }

  b.dayBurden = b.earlyStartComponent + b.nightComponent + b.lateFinishComponent + b.durationComponent + b.transportComponent;
  return b;
}

// ---------------------------------------------------------------------------
// Public: per-shift and per-transition burden
// ---------------------------------------------------------------------------

/**
 * Burden of working `code` on the real calendar `date`: a duration term
 * (linear in real hours / referenceDurationHours) plus a circadian term
 * (hours started before the early-start threshold, hours inside the night
 * window, hours finished after the late-finish threshold — overnight shifts
 * are measured on one continuous timeline across midnight). Times come
 * from getShiftTimesAs(code, date), so the same code can carry different
 * burden either side of 2026-09-20 (e.g. MT02 04:30 -> 03:45 start).
 *
 * `transportContext` is INERT at the default transportBurdenWeight of 0.
 * Returns 0 when the model is disabled (the default).
 */
export function computeShiftBurden(
  code: string,
  date: string,
  config: FatigueConfig = DEFAULT_FATIGUE_CONFIG,
  transportContext?: TransportBurdenContext
): number {
  return computeShiftBurdenBreakdown(code, date, config, transportContext).dayBurden;
}

/** computeShiftBurden's full named breakdown (transitionComponent 0 — a single shift has no transition). */
export function computeShiftBurdenBreakdown(
  code: string,
  date: string,
  config: FatigueConfig = DEFAULT_FATIGUE_CONFIG,
  transportContext?: TransportBurdenContext
): FatigueBurdenBreakdown {
  if (!config.enabled) return emptyBreakdown();
  return shiftBurdenBreakdownForSpan(resolveSpan(code, date), config, transportContext);
}

function daysBetween(fromDate: string, toDate: string): number {
  const a = Date.UTC(+fromDate.slice(0, 4), +fromDate.slice(5, 7) - 1, +fromDate.slice(8, 10));
  const b = Date.UTC(+toDate.slice(0, 4), +toDate.slice(5, 7) - 1, +toDate.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

/** Transition cost between two resolved spans `gapDays` calendar days apart (1 = adjacent days). */
export function transitionBurdenForSpans(prev: ResolvedSpan | null, next: ResolvedSpan, gapDays: number, config: FatigueConfig = DEFAULT_FATIGUE_CONFIG): number {
  if (!config.enabled || config.weights.transitionWeight === 0 || !prev || gapDays < 1) return 0;
  const t = config.thresholds;

  // Start-time swing, circular clock distance in hours (0..12).
  const prevStartClock = prev.startMin % 1440;
  const nextStartClock = next.startMin % 1440;
  const diff = Math.abs(prevStartClock - nextStartClock);
  const swingHours = Math.min(diff, 1440 - diff) / 60;
  let swingCost = Math.max(0, swingHours - t.transitionComfortableSwingHours) / Math.max(1e-9, 12 - t.transitionComfortableSwingHours);
  // Backward rotation (next starts EARLIER in the day, measured the short way round) is the harder direction.
  const signed = ((nextStartClock - prevStartClock + 1440 + 720) % 1440) - 720; // (-720, 720]
  if (signed < 0) swingCost *= t.transitionBackwardRotationFactor;

  const damping = Math.pow(t.transitionOffDayDamping, gapDays - 1);
  return config.weights.transitionWeight * swingCost * damping;
}

/**
 * Bounded SOFT cost for a large swing in working period between two worked
 * days (`previousShift` null = no previous worked shift known -> 0): the
 * circular start-time swing beyond a comfortable band
 * (transitionComfortableSwingHours -> 0 cost; a 12h swing -> full cost),
 * weighted up by transitionBackwardRotationFactor when the next start is
 * EARLIER in the day (backward rotation — e.g. a late shift followed by an
 * early one), and damped by transitionOffDayDamping per intervening OFF
 * day. Same time-of-day on consecutive days costs exactly 0.
 *
 * This is NEVER a legality check and can never override the hard 15h rest
 * rule: it returns a number only (never a verdict), is bounded by
 * transitionWeight * transitionBackwardRotationFactor, and callers must
 * still filter illegal transitions separately (as Stage 6/6.5 already do).
 * It prices only the SHAPE of a legal change, not rest length.
 */
export function computeTransitionBurden(
  previousShift: ShiftOnDate | null,
  nextShift: ShiftOnDate,
  config: FatigueConfig = DEFAULT_FATIGUE_CONFIG
): number {
  if (!config.enabled || !previousShift) return 0;
  return transitionBurdenForSpans(
    resolveSpan(previousShift.code, previousShift.date),
    resolveSpan(nextShift.code, nextShift.date),
    daysBetween(previousShift.date, nextShift.date),
    config
  );
}

/** Maximum value computeTransitionBurden can ever return for a config — the bound documented above. */
export function maxTransitionBurden(config: FatigueConfig = DEFAULT_FATIGUE_CONFIG): number {
  if (!config.enabled) return 0;
  return config.weights.transitionWeight * Math.max(1, config.thresholds.transitionBackwardRotationFactor);
}

/** Full day breakdown for a worked shift, including the transition from the previous worked shift (if any). */
export function computeDayBurdenBreakdown(
  previousShift: ShiftOnDate | null,
  shift: ShiftOnDate,
  config: FatigueConfig = DEFAULT_FATIGUE_CONFIG,
  transportContext?: TransportBurdenContext
): FatigueBurdenBreakdown {
  const b = computeShiftBurdenBreakdown(shift.code, shift.date, config, transportContext);
  if (!config.enabled) return b;
  b.transitionComponent = computeTransitionBurden(previousShift, shift, config);
  b.dayBurden += b.transitionComponent;
  return b;
}

// ---------------------------------------------------------------------------
// Accumulation
// ---------------------------------------------------------------------------

/**
 * Folds one day into a fatigue state. PROTOTYPE CURVE SHAPE (engineering
 * assumption, not a scientific claim):
 *
 *  - WORK day: `dayBurden` is added in full (no silent partial recovery
 *    between consecutive shifts — recovery is only credited on OFF days).
 *    If the day is DIFFICULT (dayBurden >= difficultDayBurdenThreshold) and
 *    extends a run of difficult days, it COMPOUNDS: day k of the run costs
 *    dayBurden * (1 + consecutiveDifficultShiftWeight * (k - 1)). So five
 *    consecutive very-early starts cost strictly more than the same five
 *    burdens spread out, and far more than five daytime shifts of similar
 *    length (whose burden sits below the threshold and never compounds).
 *  - OFF day: GEOMETRIC DECAY. Day k of a consecutive OFF run removes a
 *    fraction min(maxSingleDayRecoveryFraction, recoveryWeight * (1 +
 *    consecutiveOffRecoveryBonus * (k - 1))) of what is left. So two
 *    consecutive OFF days recover more than one — and the second more than
 *    the first — but no single OFF day can remove more than
 *    maxSingleDayRecoveryFraction (0.75 by default): legitimate accumulated
 *    burden is never fully erased by one day, and geometric decay never
 *    reaches exactly zero.
 *
 * `priorState` null or unknown -> starts from a neutral zero baseline
 * tagged "unknown_start" (never an invented history). `dayBreakdown`
 * (optional) supplies the named components for a work day so the state
 * can track recent early/night/late load for explanations; without it the
 * work day is attributed to duration only. When the model is disabled the
 * state still advances its day counters but no burden is ever added.
 */
export function accumulateFatigue(
  priorState: FatigueStateOrUnknown | null,
  dayBurden: number,
  wasOffDay: boolean,
  recoveryWeight: number,
  config: FatigueConfig = DEFAULT_FATIGUE_CONFIG,
  dayBreakdown?: FatigueBurdenBreakdown
): FatigueState {
  const prior: FatigueState = priorState && priorState.known ? priorState : neutralFatigueState("unknown_start");
  const t = config.thresholds;
  const next: FatigueState = { ...prior, recent: { ...prior.recent }, daysObserved: prior.daysObserved + 1 };

  if (wasOffDay) {
    next.consecutiveOffDays = prior.consecutiveOffDays + 1;
    next.consecutiveWorkDays = 0;
    next.consecutiveDifficultDays = 0;
    next.consecutiveVeryEarlyDays = 0;
    const k = next.consecutiveOffDays;
    const fraction = config.enabled
      ? Math.min(t.maxSingleDayRecoveryFraction, Math.max(0, recoveryWeight) * (1 + t.consecutiveOffRecoveryBonus * (k - 1)))
      : 0;
    const credit = prior.accumulatedBurden * fraction;
    next.accumulatedBurden = prior.accumulatedBurden - credit;
    for (const key of Object.keys(next.recent) as (keyof RecentComponentLoad)[]) next.recent[key] = prior.recent[key] * (1 - fraction);
    next.lastDay = { ...emptyBreakdown(), recoveryCredit: credit };
    return next;
  }

  next.consecutiveOffDays = 0;
  next.consecutiveWorkDays = prior.consecutiveWorkDays + 1;
  const burden = config.enabled ? Math.max(0, dayBurden) : 0;
  const difficult = config.enabled && burden >= t.difficultDayBurdenThreshold;
  next.consecutiveDifficultDays = difficult ? prior.consecutiveDifficultDays + 1 : 0;
  next.consecutiveVeryEarlyDays = dayBreakdown?.isVeryEarlyStart ? prior.consecutiveVeryEarlyDays + 1 : 0;

  const compounding = difficult ? config.weights.consecutiveDifficultShiftWeight * (next.consecutiveDifficultDays - 1) : 0;
  const extra = burden * Math.max(0, compounding);
  next.accumulatedBurden = prior.accumulatedBurden + burden + extra;

  const b = dayBreakdown ? { ...dayBreakdown } : { ...emptyBreakdown(), durationComponent: burden, dayBurden: burden };
  b.consecutiveDifficultComponent = extra;
  next.lastDay = b;
  if (config.enabled) {
    next.recent.early += b.earlyStartComponent;
    next.recent.night += b.nightComponent;
    next.recent.lateFinish += b.lateFinishComponent;
    next.recent.duration += b.durationComponent;
    next.recent.transition += b.transitionComponent;
  }
  return next;
}

/**
 * Convenience: folds a whole sequence of days (null = OFF) of real shifts
 * into a state, computing each day's breakdown (including the transition
 * from the previous WORKED day across any OFF days) through the real
 * date-resolved catalog.
 */
export function accumulateFatigueOverDays(
  priorState: FatigueStateOrUnknown | null,
  days: (ShiftOnDate | null)[],
  config: FatigueConfig = DEFAULT_FATIGUE_CONFIG,
  transportContextFor?: (shift: ShiftOnDate) => TransportBurdenContext | undefined
): FatigueState {
  let state: FatigueState = priorState && priorState.known ? priorState : neutralFatigueState("unknown_start");
  let lastWorked: ShiftOnDate | null = null;
  for (const day of days) {
    if (!day) {
      state = accumulateFatigue(state, 0, true, config.weights.recoveryWeight, config);
      continue;
    }
    const breakdown = computeDayBurdenBreakdown(lastWorked, day, config, transportContextFor?.(day));
    state = accumulateFatigue(state, breakdown.dayBurden, false, config.weights.recoveryWeight, config, breakdown);
    lastWorked = day;
  }
  return state;
}

// ---------------------------------------------------------------------------
// Explainability
// ---------------------------------------------------------------------------

export interface ExplainFatigueOptions {
  /** The alternative candidate's state — enables comparative labels ("Lower recent ... burden"). */
  comparedWith?: FatigueStateOrUnknown;
  /** Breakdown of the shift being considered for THIS candidate/alternative (for "Avoids third consecutive very-early shift"). */
  candidateShift?: FatigueBurdenBreakdown;
  /** Caller-supplied structural fact: choosing this candidate keeps a consecutive OFF/OFF block intact where the alternative would split it. */
  preservesConsecutiveRecovery?: boolean;
  /** Maximum labels returned (most salient first). Default 3. */
  maxReasons?: number;
  config?: FatigueConfig;
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh"];

/**
 * Short, neutral, human-readable reasons — NEVER a raw number, never
 * medical language (no "fatigued", "unsafe", "exhausted"). Picks up to
 * `maxReasons` of the most salient factors from the structured state, so a
 * later explanation UI does not need to re-derive any math. Returns [] when
 * the model is disabled.
 */
export function explainFatigueFactors(state: FatigueStateOrUnknown, options: ExplainFatigueOptions = {}): string[] {
  const config = options.config ?? DEFAULT_FATIGUE_CONFIG;
  if (!config.enabled) return [];
  const maxReasons = options.maxReasons ?? 3;
  const minDiff = config.thresholds.explanationMinDifference;
  const reasons: { label: string; salience: number }[] = [];

  if (!state.known) {
    reasons.push({ label: "No prior-week workload history available (neutral starting point)", salience: 0.5 });
  }

  if (options.preservesConsecutiveRecovery) {
    reasons.push({ label: "Preserves consecutive weekly recovery", salience: 10 });
  }

  const other = options.comparedWith;
  if (state.known && other?.known) {
    if (options.candidateShift?.isVeryEarlyStart && other.consecutiveVeryEarlyDays >= 2 && state.consecutiveVeryEarlyDays < other.consecutiveVeryEarlyDays) {
      const nth = other.consecutiveVeryEarlyDays + 1;
      const word = ORDINALS[nth - 1] ?? "another";
      reasons.push({ label: `Avoids ${word} consecutive very-early shift`, salience: 8 });
    }
    const comparisons: [keyof RecentComponentLoad, string][] = [
      ["early", "Lower recent early-shift burden"],
      ["night", "Lower recent night-work burden"],
      ["lateFinish", "Lower recent late-finish burden"],
      ["transition", "Fewer recent large shift-time changes"],
    ];
    for (const [key, label] of comparisons) {
      const d = other.recent[key] - state.recent[key];
      if (d >= minDiff) reasons.push({ label, salience: d });
    }
    const overall = other.accumulatedBurden - state.accumulatedBurden;
    if (overall >= minDiff) reasons.push({ label: "Lower recent overall workload burden", salience: overall * 0.5 });
  }

  if (state.known && state.lastDay && state.lastDay.recoveryCredit > 0 && state.consecutiveOffDays >= 2) {
    reasons.push({ label: "Coming off consecutive recovery days", salience: 1 });
  }

  // Deterministic: by salience desc, then label.
  reasons.sort((a, b) => b.salience - a.salience || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return reasons.slice(0, maxReasons).map((r) => r.label);
}

// ---------------------------------------------------------------------------
// Transport metadata lookup — architecture only (INERT)
// ---------------------------------------------------------------------------

export type TransportContextLookup =
  | { known: true; context: TransportBurdenContext; caveats: string[] }
  | { known: false; reason: string };

/**
 * Exposes lib/shift-templates.ts's TRANSPORT_METADATA as a candidate
 * TransportBurdenContext for a shift, with every known data-quality caveat
 * attached. INERT: its result only matters if a caller passes it to the
 * burden functions AND transportBurdenWeight is non-zero (it is 0 by
 * default — see lib/fatigue-config.ts's reliability judgment). Returns
 * { known: false } whenever the metadata does not cover the code/regime or
 * is internally inconsistent — never a guessed value. Pure lookup: it
 * never influences availability, eligibility, rest or capacity.
 */
export function lookupTransportContext(code: string, date: string): TransportContextLookup {
  if (resolveShiftRegime(date) !== "POST_2026_09_20") {
    return { known: false, reason: "Transport metadata exists only for the GMT regime (on/after 2026-09-20)." };
  }
  const span = resolveSpan(code, date);
  const caveats: string[] = ["Unconfirmed shuttle reporting/release times — not operational availability."];
  let before: number | null = null;
  let after: number | null = null;
  if (code === "JR02" || code === "MT02") before = span.startMin - toMin(TRANSPORT_METADATA.transportEquipeAF.entree);
  if (code === "JR02" || code === "MT03") {
    after = toMin(TRANSPORT_METADATA.transportEquipeAF.sortie) - (span.endMin % 1440);
    caveats.push("transportEquipeAF.sortie source row date reads 2027 (likely typo for 2026, unconfirmed).");
  }
  if (code === "AP03" || code === "AP04") after = toMin(TRANSPORT_METADATA.transportRegions.sortie) - (span.endMin % 1440);
  if (before === null && after === null) return { known: false, reason: `No transport metadata for ${code}.` };
  if ((before !== null && before < 0) || (after !== null && after < 0)) {
    return { known: false, reason: `Transport metadata for ${code} is inconsistent with its resolved shift times.` };
  }
  return { known: true, context: { extraMinutesBefore: before ?? 0, extraMinutesAfter: after ?? 0 }, caveats };
}
