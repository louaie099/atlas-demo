import { Employee, Flight, StaffingRequirement } from "./types";
import { shiftCatalogForDate, getShiftDurationHours, LEGACY_BASELINE_DATE } from "./shift-templates";
import { wouldExceedConsecutiveDayCap, wouldExceedHardWeeklyHoursCap } from "./planning/hard-work-caps";

/**
 * HARD WORK CAPS for ONE specific employee (2026-09-25, hard-constraints
 * milestone phase 1 — see lib/planning/hard-work-caps.ts), evaluated by
 * selectCompatibleShiftCodes in the same filter step as its optional rest
 * check: working today at all must not make this the
 * (maxConsecutiveWorkDays + 1)th consecutive calendar work day, and a
 * candidate code must not push the displayed week's hours past
 * hardWeeklyHoursCap. Like the rest filter, only meaningful when ranking for
 * one specific person.
 */
export interface EmployeeHardCapFilter {
  consecutiveWorkDaysBeforeToday: number;
  maxConsecutiveWorkDays: number;
  hoursSoFarThisWeek: number;
  hardWeeklyHoursCap: number;
}
import { computeForeignCompanyProtectedWindow } from "./foreign-company-window";
import { restHoursBetween } from "./roster-generation";

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTime(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

/**
 * Selects the RAM Handling shift code that covers a given protected
 * window, from the authoritative shift catalog — never a hardcoded
 * per-company mapping. By default (`allowLateStart` false — every
 * existing caller), a shift is compatible only if it starts at or before
 * the window start AND ends at or after the window end (i.e. the shift
 * fully contains the window) — this is the right rule for a foreign
 * company's protected/contractual window, which genuinely needs full
 * coverage from open to close.
 *
 * `allowLateStart: true` relaxes only the start-side requirement: a shift
 * starting AFTER windowStart still qualifies, as long as it starts at or
 * before windowEnd (genuine overlap, never a shift that only begins after
 * the window has already closed) AND still runs through windowEnd. This exists for demand-CLUSTER matching
 * (shift-generation.ts's General T1 loop, specialized-team-generation.ts's
 * Profiling/Mesure), where the window is the full contiguous span of a
 * role's demand that day — not one company's single dedicated commitment
 * — and scoring.ts's actual per-flight duty assignment (Stage 9) already
 * treats a late-starting-but-otherwise-overlapping shift as normal and
 * expected, never a bug (see its own doc comment: "A shift starting
 * somewhat after the window's own start is ... exactly how real shift
 * coverage works"). Before this option existed, Stage 6 was silently
 * STRICTER than Stage 9 could ever need: a demand cluster whose start
 * predates every catalog code's earliest entree (e.g. a Check-in window
 * opening T-3h before an early-morning departure, versus the earliest
 * catalog entree of 04:30) got ZERO compatible codes here and so never
 * got anyone rostered at all — even though Stage 9 would have happily
 * used a 04:30-start shift to cover everything from 04:30 through
 * departure. `allowLateStart` makes Stage 6's matching exactly as
 * permissive as Stage 9 already is, no more.
 *
 * Among compatible shifts, prefers (1) the smallest coverage loss at the
 * start — 0 for any shift starting at or before windowStart, otherwise
 * how many minutes late it starts — then (2) the shortest total shift
 * duration (don't roster someone longer than necessary). This is what
 * makes "Gulf Air at 09:00 → MT02" fall out of the general rule rather
 * than being a special case for Gulf Air.
 *
 * Deliberately does not handle shifts or windows that cross midnight —
 * a documented limitation for overnight company flights, not silently
 * guessed. Returns null (never a fabricated shift) if no catalog code is
 * compatible.
 *
 * Optional cross-day rest awareness: when `adjacentShiftStart`/
 * `adjacentShiftEnd` (the employee's actual shift on the immediately
 * preceding calendar day) and `minimumRestHours` are all given, a
 * candidate is only eligible if it also leaves at least that much rest
 * since that prior shift — evaluated with the exact same rest definition
 * used everywhere else (`restHoursBetween`, lib/roster-generation.ts),
 * which needs the prior shift's START too so an overnight prior shift
 * (ending after midnight) is measured correctly rather than by naive
 * clock-time subtraction. Ranking among the REMAINING eligible candidates
 * is unchanged (closest fit, then shortest duration) — this never relaxes
 * the rest rule to get a "better" fit; it only ever narrows the candidate
 * pool. Returns null — never a shift that knowingly breaks rest — if no
 * candidate qualifies.
 */
export function selectCompatibleShiftCode(
  windowStart: string,
  windowEnd: string,
  adjacentShiftStart?: string | null,
  adjacentShiftEnd?: string | null,
  minimumRestHours?: number,
  allowLateStart = false,
  preferExtended = false,
  // The real calendar date being planned for — resolves which shift
  // regime's entrée/sortie catalog is used (see lib/shift-templates.ts).
  // Defaults to LEGACY_BASELINE_DATE (the pre-2026-09-20 regime) so every
  // existing test/caller that has no real plan date in scope keeps
  // resolving the exact same OLD-regime codes it always did — a REAL
  // planning caller (specialized-team-generation.ts) always passes its
  // own real date explicitly instead of relying on this default.
  date: string = LEGACY_BASELINE_DATE
): string | null {
  return (
    selectCompatibleShiftCodes(windowStart, windowEnd, adjacentShiftStart, adjacentShiftEnd, minimumRestHours, allowLateStart, preferExtended, date)[0]
      ?.code ?? null
  );
}

/**
 * Same matching/ranking rule as selectCompatibleShiftCode, but returns the
 * FULL ranked candidate list instead of only the top match. This exists
 * for demand-driven capacity planning (see shift-generation.ts): the
 * single nearest-fit code is still tried first, but if no employee who's
 * otherwise eligible (skill, availability) can actually take it without
 * breaking rest, the NEXT-best compatible code is a genuinely different,
 * still-valid way to cover the same demand window — falling straight to
 * "understaffed" after only one candidate would be needlessly
 * pessimistic. `selectCompatibleShiftCode` above stays the thin
 * single-answer wrapper every existing caller keeps using unchanged.
 *
 * NOTE: the optional adjacent-shift/rest filter here is a coarse,
 * SINGLE-employee pre-filter (kept for backward compatibility with
 * existing callers) — a real per-employee rest check against each
 * candidate's actual entree time still happens in shift-generation.ts's
 * greedy loop, since different employees have different prior/next
 * shifts. Don't rely on this parameter to guarantee rest for a whole pool
 * of employees; pass it only when ranking for one specific person.
 */
export function selectCompatibleShiftCodes(
  windowStart: string,
  windowEnd: string,
  adjacentShiftStart?: string | null,
  adjacentShiftEnd?: string | null,
  minimumRestHours?: number,
  allowLateStart = false,
  // CROSS-TEAM REDEPLOYMENT (see teams.ts's isRedeploymentAllowed and the
  // known-limitations doc): default false, every existing caller
  // unaffected. When true, reverses ONLY the second tie-break — among
  // candidates tied on start-side coverage loss, prefer the LONGEST
  // compatible shift rather than the shortest. A specialized/foreign
  // team's window is exactly what their own commitment needs; picking a
  // longer catalog shift than strictly required leaves genuine, real
  // slack time either before or after that window on the employee's
  // actual shift — time scoreCandidates can then legitimately offer for
  // other RAM duty, since a person really is on shift then, not "OFF but
  // pretending to be available." Never changes which codes are
  // ELIGIBLE (the filter above, and the optional rest filter below, are
  // both unaffected) — only which eligible code is preferred first.
  preferExtended = false,
  // See selectCompatibleShiftCode's own doc comment on this parameter —
  // same default/rationale.
  date: string = LEGACY_BASELINE_DATE,
  // HARD WORK CAPS (2026-09-25, phase 1) — see EmployeeHardCapFilter.
  // Optional; omitted = no cap filtering (every existing caller unchanged).
  // Like the rest filter above, it only ever NARROWS the candidate pool.
  hardCapFilter?: EmployeeHardCapFilter
): { code: string; entree: string; sortie: string }[] {
  const windowStartMin = timeToMinutes(windowStart);
  const windowEndMin = timeToMinutes(windowEnd);

  let candidates = Object.entries(shiftCatalogForDate(date))
    .map(([code, { entree, sortie }]) => ({
      code,
      entreeMin: timeToMinutes(entree),
      sortieMin: timeToMinutes(sortie),
    }))
    .filter((c) => c.sortieMin > c.entreeMin) // exclude overnight-wrapping codes from this matcher
    .filter(
      (c) =>
        (allowLateStart ? c.entreeMin <= windowEndMin : c.entreeMin <= windowStartMin) && c.sortieMin >= windowEndMin
    );

  if (adjacentShiftStart != null && adjacentShiftEnd != null && minimumRestHours != null) {
    candidates = candidates.filter(
      (c) => restHoursBetween(adjacentShiftStart, adjacentShiftEnd, minutesToTime(c.entreeMin)) >= minimumRestHours
    );
  }

  if (hardCapFilter) {
    if (wouldExceedConsecutiveDayCap(hardCapFilter.consecutiveWorkDaysBeforeToday, true, hardCapFilter.maxConsecutiveWorkDays)) {
      candidates = [];
    } else {
      candidates = candidates.filter(
        (c) => !wouldExceedHardWeeklyHoursCap(hardCapFilter.hoursSoFarThisWeek, getShiftDurationHours(c.code, date), hardCapFilter.hardWeeklyHoursCap)
      );
    }
  }

  candidates.sort((a, b) => {
    const lossA = Math.max(0, a.entreeMin - windowStartMin);
    const lossB = Math.max(0, b.entreeMin - windowStartMin);
    if (lossA !== lossB) return lossA - lossB;
    const durationA = a.sortieMin - a.entreeMin;
    const durationB = b.sortieMin - b.entreeMin;
    return preferExtended ? durationB - durationA : durationA - durationB;
  });

  return candidates.map((c) => ({ code: c.code, entree: minutesToTime(c.entreeMin), sortie: minutesToTime(c.sortieMin) }));
}

/**
 * Finds EVERY flight a given company operates on a given day — never
 * assumes at most one. Returns an empty array (never a fabricated flight)
 * if that company has no flight that day.
 */
export function findCompanyFlightsOnDay(company: string, dayOfWeek: string, flights: Flight[]): Flight[] {
  return flights.filter((f) => f.airline === company && f.day_of_week === dayOfWeek);
}

export interface FlightWindow {
  flight: Flight;
  window: { start: string; end: string };
}

export interface ForeignDayPlan {
  flights: Flight[]; // every company flight that day (always >= 1 when this is non-null)
  windows: FlightWindow[]; // each flight's own individual protected window
  combinedWindow: { start: string; end: string }; // union span, used only for shift selection
  shiftCode: string | null;
}

/**
 * The core rule this module exists for: company flight schedule drives
 * the roster, not the other way around. Given a company and a day, if
 * that company has one or more flights that day, this computes each
 * flight's own protected window (kept separate, for precise per-flight
 * overlap checks elsewhere), the combined span across all of them (used
 * only to pick one RAM shift that covers the whole day's company
 * operation), and the compatible shift for that combined span.
 *
 * Returns null — never a fake plan — if there's no flight that day.
 *
 * `adjacentShiftStart`/`adjacentShiftEnd`/`minimumRestHours` (optional):
 * same cross-day rest awareness as selectCompatibleShiftCode, threaded
 * through so a caller building a sequential weekly roster (see
 * seed-data.ts's applyForeignCompanyRoster) can pick a shift that both
 * covers the protected window AND respects the employee's rest since
 * their previous day — never one that only satisfies coverage.
 */
export function planForeignCompanyDay(
  company: string,
  dayOfWeek: string,
  flights: Flight[],
  adjacentShiftStart?: string | null,
  adjacentShiftEnd?: string | null,
  minimumRestHours?: number,
  // The real calendar date being planned for — see
  // selectCompatibleShiftCode's own doc comment on the same parameter/
  // default.
  date: string = LEGACY_BASELINE_DATE
): ForeignDayPlan | null {
  const dayFlights = findCompanyFlightsOnDay(company, dayOfWeek, flights);
  if (dayFlights.length === 0) return null;

  const windows: FlightWindow[] = dayFlights.map((flight) => ({
    flight,
    window: computeForeignCompanyProtectedWindow(flight),
  }));

  const combinedStartMin = Math.min(...windows.map((w) => timeToMinutes(w.window.start)));
  const combinedEndMin = Math.max(...windows.map((w) => timeToMinutes(w.window.end)));
  const combinedWindow = { start: minutesToTime(combinedStartMin), end: minutesToTime(combinedEndMin) };

  const shiftCode = selectCompatibleShiftCode(
    combinedWindow.start,
    combinedWindow.end,
    adjacentShiftStart,
    adjacentShiftEnd,
    minimumRestHours,
    false,
    false,
    date
  );

  return { flights: dayFlights, windows, combinedWindow, shiftCode };
}

export interface ForeignCommitmentAssignment {
  id: string;
  staffing_requirement_id: string;
  employee_id: string;
}

/**
 * Builds the real duty Assignment rows for every configured foreign
 * company's flights across the week — enforcing two invariants that a
 * previous version of this logic violated:
 *
 * 1. HEADCOUNT: never more than requirement.total_requirement distinct
 *    employees per (flight, requirement) — company team membership or
 *    authorization is NOT the same as being assigned to a specific
 *    flight. Only the number of employees the requirement actually needs
 *    is selected from the pool of employees genuinely working that day
 *    with a shift covering the flight's protected window; every other
 *    company employee keeps their normal RAM Handling shift that day
 *    without holding a duty on this flight.
 * 2. NO DOUBLE-BOOKING: an employee selected for one of a company's
 *    same-day flights is removed from that day's available pool before
 *    the next same-day flight (if any) is considered, so nobody can be
 *    assigned to two overlapping company flights on one day.
 *
 * Deterministic: employees are selected in the order they appear in
 * `employees` (never randomized), so Reset Demo always reproduces the
 * exact same scenario.
 */
export function buildForeignCommitmentAssignments(
  employees: Employee[],
  flights: Flight[],
  requirements: StaffingRequirement[],
  daysOrder: string[],
  configuredCompanies: string[]
): ForeignCommitmentAssignment[] {
  const foreignAssignmentEmployees = employees.filter((e) => configuredCompanies.includes(e.assignment));
  const assignments: ForeignCommitmentAssignment[] = [];

  for (const day of daysOrder) {
    for (const company of configuredCompanies) {
      const plan = planForeignCompanyDay(company, day, flights);
      if (!plan || !plan.shiftCode) continue; // no flight that day, or no compatible shift — no commitment to record

      let availablePool = foreignAssignmentEmployees.filter((e) => {
        if (e.assignment !== company) return false;
        const dayEntry = e.weekly_shifts.find((s) => s.day_of_week === day);
        return dayEntry?.status !== "off";
      });

      for (const { flight } of plan.windows) {
        const requirement = requirements.find((r) => r.flight_id === flight.id && !r.needs_configuration);
        if (!requirement) continue;

        const selected = availablePool.slice(0, requirement.total_requirement);
        for (const emp of selected) {
          assignments.push({
            id: `assign-foreign-${emp.id}-${flight.id}`,
            staffing_requirement_id: requirement.id,
            employee_id: emp.id,
          });
        }

        const selectedIds = new Set(selected.map((e) => e.id));
        availablePool = availablePool.filter((e) => !selectedIds.has(e.id));
      }
    }
  }

  return assignments;
}
