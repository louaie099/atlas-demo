/**
 * Authoritative shift codes, EFFECTIVE-DATED (2026-09-23 rewrite).
 *
 * RAM Handling switches its operational time reference from GMT+1 to GMT
 * on Sunday 2026-09-20. This is NOT a display/timezone relabeling — the
 * real flight program and employee shift entrée/sortie times both shift.
 * A confirmed, row-by-row audit of RAM's official change sheet against
 * the OLD GMT+1 catalog below produced, per shift code, one of three
 * outcomes:
 *
 *   CONFIRMED   — the change sheet directly names this exact code (or an
 *                 unambiguous shared-value group of codes) for this field.
 *   INHERITED   — no operational-type row in the change sheet addresses
 *                 this field at all (only a transport/circuit-labeled row
 *                 touches the code, or nothing does). Falls back to the
 *                 value already sitting in the OLD, never-applied,
 *                 purely-speculative `SHIFT_CODES_GMT_SPECULATIVE` table
 *                 below (or, failing that, the OLD GMT+1 value itself) as
 *                 the best available guess — explicitly NOT confirmed by
 *                 the new document.
 *   AMBIGUOUS   — the change sheet gives a value, but it cannot be
 *                 confidently assigned to this specific code (see AP01/
 *                 AP02 sortie below). The OLD value is kept unchanged
 *                 rather than guessing.
 *
 * See docs/known-limitations/roster-planning-vs-duty-allocation.md's
 * 2026-09-23 addendum for the full per-code table and rationale. Do not
 * add a new value to SHIFT_CODES_GMT_EFFECTIVE_2026_09_20 without a
 * documented CONFIRMED/INHERITED/AMBIGUOUS classification next to it.
 *
 * "Entrée féminin" appears in the same reference table but is explicitly
 * NOT a shift — it's a minimum clock-in time policy, kept separate below
 * (FEMALE_ENTREE_POLICY), never included in a shift catalog and never
 * assignable to an employee as a shift_code. The audit confirmed its
 * values are unchanged by the new regime document — no action needed
 * there.
 */

interface ShiftTime {
  entree: string;
  sortie: string;
}

/** The OLD regime — active for every calendar date strictly before REGIME_CHANGE_DATE. Unchanged from the pre-existing catalog. */
const SHIFT_CODES_GMT_PLUS_1: Record<string, ShiftTime> = {
  JR01: { entree: "05:45", sortie: "18:15" },
  MT02: { entree: "04:30", sortie: "14:45" },
  MT01: { entree: "05:45", sortie: "14:45" },
  MT03: { entree: "05:45", sortie: "15:45" },
  NR01: { entree: "08:00", sortie: "16:45" },
  NR02: { entree: "08:00", sortie: "18:15" },
  AP01: { entree: "13:45", sortie: "22:45" },
  AP02: { entree: "13:45", sortie: "23:15" },
  AP03: { entree: "17:45", sortie: "02:00" },
  AP04: { entree: "13:45", sortie: "02:00" },
  NT01: { entree: "17:45", sortie: "06:15" },
  JR02: { entree: "04:30", sortie: "16:45" },
  N8: { entree: "21:00", sortie: "06:15" },
};

/**
 * HISTORICAL / SPECULATIVE ONLY — a GUESS made BEFORE RAM's real change
 * sheet existed ("the reason for the difference... was not specified").
 * Never applied to any date. Kept only because several INHERITED fields
 * in SHIFT_CODES_GMT_EFFECTIVE_2026_09_20 below were sourced from it (as
 * the best available fallback, still NOT confirmed by the real document)
 * — retained here, unexported, purely as that provenance record. Do NOT
 * confuse this with SHIFT_CODES_GMT_EFFECTIVE_2026_09_20: this table was
 * never real, that one is the actual effective-dated regime.
 */
const SHIFT_CODES_GMT_SPECULATIVE: Record<string, ShiftTime> = {
  JR01: { entree: "05:45", sortie: "18:15" },
  MT02: { entree: "03:45", sortie: "13:45" },
  MT01: { entree: "04:45", sortie: "13:45" },
  MT03: { entree: "04:45", sortie: "14:45" },
  NR01: { entree: "08:00", sortie: "16:45" },
  NR02: { entree: "08:00", sortie: "18:15" },
  AP01: { entree: "12:45", sortie: "21:45" },
  AP02: { entree: "12:45", sortie: "22:15" },
  AP03: { entree: "17:45", sortie: "01:15" },
  AP04: { entree: "12:45", sortie: "01:15" },
  NT01: { entree: "17:45", sortie: "06:15" },
  JR02: { entree: "03:45", sortie: "16:45" },
  N8: { entree: "20:45", sortie: "06:15" },
};

/**
 * The NEW regime — effective for every calendar date on or after
 * REGIME_CHANGE_DATE (2026-09-20, a Sunday). Built field-by-field from
 * the confirmed audit; see this module's own doc comment for the
 * CONFIRMED/INHERITED/AMBIGUOUS classification of every field, and
 * docs/known-limitations/roster-planning-vs-duty-allocation.md for the
 * full writeup:
 *
 *  JR01 entree 05:45 CONFIRMED (unchanged) | sortie 18:30 CONFIRMED (changed, "Circuits Sortie Brigade Matin")
 *  JR02 entree 03:45 INHERITED             | sortie 16:45 INHERITED (transport-labeled row only; suspect "2027" date)
 *  MT01 entree 05:45 CONFIRMED (unchanged) | sortie 15:00 CONFIRMED (changed, shared w/ MT02, "Circuits Sortie Équipe Matin")
 *  MT02 entree 03:45 INHERITED             | sortie 15:00 CONFIRMED (changed, shared w/ MT01)
 *  MT03 entree 05:45 CONFIRMED (unchanged) | sortie 14:45 INHERITED
 *  NR01 entree 08:00 CONFIRMED (unchanged) | sortie 17:00 CONFIRMED (changed, "Horaire Administratif")
 *  NR02 entree 08:00 INHERITED             | sortie 18:15 INHERITED (not mentioned anywhere in the document)
 *  AP01 entree 13:45 CONFIRMED (unchanged) | sortie 22:45 AMBIGUOUS (kept old — see doc comment)
 *  AP02 entree 13:45 CONFIRMED (unchanged) | sortie 23:15 AMBIGUOUS (kept old — see doc comment)
 *  AP03 entree 17:45 CONFIRMED (unchanged) | sortie 01:15 INHERITED
 *  AP04 entree 13:45 CONFIRMED (unchanged) | sortie 01:15 INHERITED
 *  NT01 entree 17:45 CONFIRMED (unchanged) | sortie 06:30 CONFIRMED (changed, "Circuits Sortie Équipe Nuit + Brigade Nuit")
 *  N8   entree 21:30 CONFIRMED (changed)   | sortie 06:30 CONFIRMED (changed)
 */
const SHIFT_CODES_GMT_EFFECTIVE_2026_09_20: Record<string, ShiftTime> = {
  JR01: { entree: "05:45", sortie: "18:30" },
  MT02: { entree: "03:45", sortie: "15:00" },
  MT01: { entree: "05:45", sortie: "15:00" },
  MT03: { entree: "05:45", sortie: "14:45" },
  NR01: { entree: "08:00", sortie: "17:00" },
  NR02: { entree: "08:00", sortie: "18:15" },
  AP01: { entree: "13:45", sortie: "22:45" },
  AP02: { entree: "13:45", sortie: "23:15" },
  AP03: { entree: "17:45", sortie: "01:15" },
  AP04: { entree: "13:45", sortie: "01:15" },
  NT01: { entree: "17:45", sortie: "06:30" },
  JR02: { entree: "03:45", sortie: "16:45" },
  N8: { entree: "21:30", sortie: "06:30" },
};

// Policy note, not a shift. Kept separate deliberately. Audit confirmed
// (2026-09-23): these values match RAM's new change sheet exactly for
// both regimes — no update needed for the 2026-09-20 transition.
export const FEMALE_ENTREE_POLICY = {
  "GMT+1": { earliestEntree: "05:30", reference: "14:45" },
  GMT: { earliestEntree: "04:30", reference: "13:45" },
};

/**
 * TRANSPORT/CIRCUIT METADATA — burden/reporting time, NOT operational
 * availability. These rows describe when personnel transport (a shuttle
 * bus, not the employee's own working shift) departs/arrives — they are
 * NOT shift entrée/sortie times and must never be used for eligibility,
 * rest calculations, or T1 capacity. Preserved here, clearly separated
 * from SHIFT_CODES_*, solely so this data isn't lost before a future
 * fatigue model can make use of it (the same reasoning FEMALE_ENTREE_POLICY
 * is already kept separate from the shift catalog for).
 */
export const TRANSPORT_METADATA = {
  /** Personnel transport for JR02/MT02 (entrée) and JR02/MT03 (sortie), GMT. */
  transportEquipeAF: {
    entree: "03:00", // GMT — JR02/MT02
    // The document's sortie row reads "2027" for its date — almost
    // certainly a typo for 2026, flagged here rather than silently
    // corrected or silently trusted.
    sortie: "15:15", // GMT — JR02/MT03; source row date reads "2027" (likely a typo)
  },
  /** Regional personnel transport for AP03/AP04 — a later shuttle, well after the actual shift end. */
  transportRegions: {
    sortie: "02:15", // GMT — AP03/AP04
  },
};

/** The calendar date (inclusive) RAM's new GMT operational regime takes effect. A Sunday. */
export const REGIME_CHANGE_DATE = "2026-09-20";

/**
 * A fixed, deliberately-OLD-regime reference date, used ONLY where a
 * caller builds a STATIC/legacy baseline value with no real plan date in
 * scope at all (lib/employee-generator.ts, lib/seed-data.ts's scripted
 * example employees/foreign-roster baseline, lib/foreign-shift-planning.ts's
 * buildForeignCommitmentAssignments — see each file's own doc comment).
 * These baseline fields are NEVER authoritative for what an actual plan
 * displays for a real calendar date on or after 2026-09-20 — every real
 * per-date read (duty generation, T1 capacity, Agent Schedule for a
 * persisted plan, rest calculations) resolves its OWN real date instead
 * and ignores this constant entirely. Using a pre-regime date here keeps
 * these legacy/seed baselines numerically identical to what they always
 * were, rather than silently starting to imply the new regime for data
 * that was never date-scoped in the first place.
 */
export const LEGACY_BASELINE_DATE = "2020-01-01";

export type ShiftRegime = "PRE_2026_09_20" | "POST_2026_09_20";

/**
 * Resolves which shift regime applies for a real calendar date
 * ("YYYY-MM-DD"). Deliberately per-DATE, never per-week: a week whose
 * days straddle the boundary must resolve each day independently (see
 * this module's tests). Plain ISO-string comparison is correct here
 * because both operands are always "YYYY-MM-DD".
 */
export function resolveShiftRegime(date: string): ShiftRegime {
  return date >= REGIME_CHANGE_DATE ? "POST_2026_09_20" : "PRE_2026_09_20";
}

function catalogForDate(date: string): Record<string, ShiftTime> {
  return resolveShiftRegime(date) === "POST_2026_09_20" ? SHIFT_CODES_GMT_EFFECTIVE_2026_09_20 : SHIFT_CODES_GMT_PLUS_1;
}

/**
 * The set of valid shift codes — identical between both regimes (no code
 * is ever added/removed by the 2026-09-20 change, only its times), so this
 * is safe to use anywhere only the CODE LIST matters (UI dropdowns,
 * "shortest catalog code" enumeration) without needing a date. Anywhere
 * an actual entrée/sortie TIME or DURATION is read, use getShiftTimes/
 * getShiftTimesAs/getShiftDurationHours with an explicit date instead —
 * never read this object's VALUES for a date-sensitive computation.
 */
export const SHIFT_CODES = SHIFT_CODES_GMT_EFFECTIVE_2026_09_20;

/**
 * The FULL catalog (code -> {entree, sortie}) actually effective for a
 * specific real calendar date — for the rare caller that needs to
 * enumerate every code's real times for a date (e.g. building the
 * "shortest legal shift" ranking, or the Stage-6 candidate set), rather
 * than looking up one code at a time via getShiftTimes. Never read
 * SHIFT_CODES's own values for a date-sensitive computation — use this
 * instead.
 */
export function shiftCatalogForDate(date: string): Record<string, ShiftTime> {
  return catalogForDate(date);
}

/**
 * The real, effective entrée/sortie for a shift code on a specific
 * calendar date ("YYYY-MM-DD"). `date` is required and deliberately not
 * defaulted — every caller must know which real date it is resolving a
 * shift for, so a regime is never silently guessed.
 */
export function getShiftTimes(code: string, date: string): ShiftTime {
  const times = catalogForDate(date)[code];
  if (!times) {
    throw new Error(`Unknown shift code "${code}" — not in the authoritative shift catalog.`);
  }
  return times;
}

/** Convenience form for building Employee objects: {shift_start, shift_end}, resolved for a specific real date. */
export function getShiftTimesAs(code: string, date: string): { shift_start: string; shift_end: string } {
  const { entree, sortie } = getShiftTimes(code, date);
  return { shift_start: entree, shift_end: sortie };
}

/**
 * Real counted working duration of a shift code, in hours, for a specific
 * real date — the single implementation every weekly-hours calculation
 * (generation-time and validation-time alike) must use, rather than each
 * caller re-deriving its own start/end diff. Correctly handles an
 * overnight code (AP03, AP04, NT01, N8) whose sortie clock-time is
 * numerically earlier than its entree: that's a same-shift wrap past
 * midnight, not a negative duration, so 24h is added back.
 */
export function getShiftDurationHours(code: string, date: string): number {
  const { entree, sortie } = getShiftTimes(code, date);
  const [eh, em] = entree.split(":").map(Number);
  const [sh, sm] = sortie.split(":").map(Number);
  let minutes = sh * 60 + sm - (eh * 60 + em);
  if (minutes <= 0) minutes += 24 * 60;
  return minutes / 60;
}

/**
 * The single shared derivation for Employee.rest_before_shift_hours — the
 * static field scoring.ts reads as its "rested" eligibility signal
 * (`employee.rest_before_shift_hours >= config.minimum_rest_hours`).
 * Every caller that builds an Employee for a shift code that repeats
 * identically on consecutive working days (lib/employee-generator.ts,
 * lib/seed-data.ts's scripted/example employees) must derive this value
 * from the shift's own catalog duration — never hand-pick an
 * independent placeholder number, which is exactly how the old 9-13h
 * values drifted out of sync with the confirmed 15h rest floor.
 *
 * For a shift that repeats identically day after day with no OFF day in
 * between, the rest gap before the next occurrence is the remainder of
 * the 24h day after this one's duration: `24 - duration`. This mirrors
 * restHoursBetween's own model for that same common case (see
 * roster-generation.ts). `date` resolves which regime's duration applies —
 * this is a STATIC seed/baseline value, so callers building it once at
 * employee-generation time should pass the date generation happens for
 * (see employee-generator.ts/seed-data.ts's own doc comments on this
 * being a baseline, superseded per-day by the resolved plan-time value
 * wherever a real plan exists).
 */
export function restHoursForDailyRepeatingShift(code: string, date: string): number {
  return Math.round((24 - getShiftDurationHours(code, date)) * 100) / 100;
}

/**
 * Builds the day-by-day weekly_shifts array for an employee. Currently
 * uniform (same shift_code every working day, "off" on off_days) — this
 * reflects that no per-day variation exists in the dataset yet. The
 * structure is what the future Weekly Planning redesign will actually vary;
 * this function's job today is only to make that structure real and
 * consistent with each employee's existing flat fields, not to invent
 * variation that doesn't exist. Never touches shift TIMES, so it needs no
 * date.
 */
export function buildUniformWeeklySchedule(
  shiftCode: string | null,
  offDays: string[],
  daysOfWeek: string[]
): { day_of_week: string; shift_code: string | null; status: "working" | "off" }[] {
  return daysOfWeek.map((day) => {
    const isOff = offDays.includes(day);
    return {
      day_of_week: day,
      shift_code: isOff ? null : shiftCode,
      status: isOff ? "off" : "working",
    };
  });
}
