/**
 * Authoritative shift codes, as provided. Two timezone regimes exist
 * (GMT+1 and GMT) — the reason for the difference (DST, seasonal
 * adjustment, or something else) was not specified, so it's not asserted
 * here. GMT+1 is used as the active regime for this demo; GMT is defined
 * for completeness but not applied anywhere.
 *
 * "Entrée féminin" appears in the same reference table but is explicitly
 * NOT a shift — it's a minimum clock-in time policy, kept separate below,
 * never included in SHIFT_CODES and never assignable to an employee as a
 * shift_code.
 */
export const ACTIVE_TIMEZONE_REGIME: "GMT+1" | "GMT" = "GMT+1";

interface ShiftTime {
  entree: string;
  sortie: string;
}

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

const SHIFT_CODES_GMT: Record<string, ShiftTime> = {
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

// Policy note, not a shift. Kept separate deliberately.
export const FEMALE_ENTREE_POLICY = {
  "GMT+1": { earliestEntree: "05:30", reference: "14:45" },
  GMT: { earliestEntree: "04:30", reference: "13:45" },
};

export const SHIFT_CODES = ACTIVE_TIMEZONE_REGIME === "GMT+1" ? SHIFT_CODES_GMT_PLUS_1 : SHIFT_CODES_GMT;

export function getShiftTimes(code: string): ShiftTime {
  const times = SHIFT_CODES[code];
  if (!times) {
    throw new Error(`Unknown shift code "${code}" — not in the authoritative shift catalog.`);
  }
  return times;
}

/** Convenience form for building Employee objects: {shift_start, shift_end}. */
export function getShiftTimesAs(code: string): { shift_start: string; shift_end: string } {
  const { entree, sortie } = getShiftTimes(code);
  return { shift_start: entree, shift_end: sortie };
}

/**
 * Real counted working duration of a shift code, in hours — the single
 * implementation every weekly-hours calculation (generation-time and
 * validation-time alike) must use, rather than each caller re-deriving
 * its own start/end diff. Correctly handles an overnight code (AP03,
 * AP04, NT01, N8) whose sortie clock-time is numerically earlier than its
 * entree: that's a same-shift wrap past midnight, not a negative
 * duration, so 24h is added back.
 */
export function getShiftDurationHours(code: string): number {
  const { entree, sortie } = getShiftTimes(code);
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
 * roster-generation.ts).
 */
export function restHoursForDailyRepeatingShift(code: string): number {
  return Math.round((24 - getShiftDurationHours(code)) * 100) / 100;
}

/**
 * Builds the day-by-day weekly_shifts array for an employee. Currently
 * uniform (same shift_code every working day, "off" on off_days) — this
 * reflects that no per-day variation exists in the dataset yet. The
 * structure is what the future Weekly Planning redesign will actually vary;
 * this function's job today is only to make that structure real and
 * consistent with each employee's existing flat fields, not to invent
 * variation that doesn't exist.
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
