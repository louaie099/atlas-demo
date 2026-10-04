import { Employee, Config, CandidateResult } from "./types";
import { isFixedPlanningTeam, isTransitTeam } from "./teams";
import { CandidateFatigueInput, rankingBurden } from "./planning/fatigue-planning";
import { explainFatigueFactors, unknownFatigueState } from "./planning/fatigue-model";

export interface TimeWindow {
  start: string; // "HH:mm"
  end: string; // "HH:mm"
}

// An employee with a real, roster-assigned shift for scoring purposes.
type RosteredEmployee = Employee & { shift_start: string; shift_end: string; rest_before_shift_hours: number; weekly_hours: number };

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function windowsOverlap(a: TimeWindow, b: TimeWindow): boolean {
  return timeToMinutes(a.start) < timeToMinutes(b.end) && timeToMinutes(b.start) < timeToMinutes(a.end);
}

/**
 * Is `window` entirely contained within [shiftStart, shiftEnd]? The single
 * shared full-shift-containment predicate — task.start >= shift.start AND
 * task.end <= shift.end — used both by scoreCandidates below (to decide
 * whether a candidate can be automatically "recommended") and by
 * lib/live-ops-service.ts (to detect when a live delay pushes an
 * INCUMBENT'S already-assigned duty outside their shift). Before the
 * 2026-10-04 planning-integrity audit, these were two separately
 * maintained copies — live-ops-service.ts's own version was already
 * correct, scoreCandidates' was not (see scoreCandidates' own doc comment
 * on `earlyStartNeeded` below for the bug this fixes). Centralized here so
 * the two can never drift apart again. Returns true (no violation) when
 * either boundary is missing, rather than guessing.
 */
export function isWindowWithinShift(window: TimeWindow, shiftStart: string | null, shiftEnd: string | null): boolean {
  if (!shiftStart || !shiftEnd) return true;
  return timeToMinutes(window.start) >= timeToMinutes(shiftStart) && timeToMinutes(window.end) <= timeToMinutes(shiftEnd);
}

function hasRosterAssigned(e: Employee): e is RosteredEmployee {
  return e.shift_start !== null && e.shift_end !== null && e.rest_before_shift_hours !== null && e.weekly_hours !== null;
}

/**
 * Ranks candidates for a staffing requirement by role. Role-agnostic —
 * used for Boarding (fixed-rule), Check-in (demand-forecast), and
 * foreign-company (company-config) gaps alike. Pure function: no I/O,
 * fully unit-testable.
 *
 * Exclusions happen before any scoring, and are not negotiable via
 * reasoning/flagging — these employees are never candidates, not even
 * flagged ones:
 *  - No roster/shift assigned yet (shift_start/shift_end/rest/weekly_hours
 *    are null) — a freshly-created employee has a workforce profile but
 *    no planning state until Weekly Planning assigns them a shift. There
 *    is nothing to evaluate rest/fairness/extension against, so they
 *    cannot be a candidate, flagged or otherwise, until they're rostered.
 *  - Fixed-planning teams (Leaders, Duty Officers, Caisse/BCB) follow
 *    specialized planning outside general ACE allocation.
 *  - Transit agents are committed to Transit for their full shift and are
 *    never available for any other role while on that team.
 *  - An employee with a protected foreign-company commitment (from a real,
 *    generated flight commitment for THIS specific date — see
 *    occupiedWindows below) whose window overlaps the requirement's own
 *    operational window. This is date/time-specific: the same employee
 *    remains eligible for a requirement outside that window, even on the
 *    same day, and remains eligible on other days entirely. Persistent
 *    foreign-company assignment/authorization alone never excludes
 *    anyone — only an actual overlapping commitment does.
 *
 * @param window The target requirement's own operational time window
 *   (e.g. a Boarding window, or an approximated Check-in window).
 * @param occupiedWindows Per-employee list of protected commitment windows
 *   for the SAME DATE as `window`, keyed by employee id. Typically derived
 *   from getEmployeeForeignCommitments(), filtered to the relevant day, by
 *   the caller — this function stays pure and doesn't fetch or compute
 *   commitments itself.
 * @param requiredAuthorization When set, eligibility is decided by real
 *   foreign-company AUTHORIZATION (`Employee.foreign_company_authorizations`
 *   includes this company name) instead of a flight-task skill match. This
 *   is how a company_config (foreign-carrier) requirement finds candidates
 *   — there is no employee "skill" that means "eligible for company X's
 *   ground operation"; authorization is the real, existing concept for
 *   that, not a manufactured qualification. Leave unset for every other
 *   requirement (Gate/Boarding/Profiling/Mesure/Check-in), which continue
 *   to match on `role` as a genuine trained capability.
 */
export function scoreCandidates(
  role: string,
  window: TimeWindow,
  employees: Employee[],
  config: Config,
  occupiedWindows: Record<string, TimeWindow[]> = {},
  requiredAuthorization?: string,
  // FAIRNESS AS A SOFT OBJECTIVE, USING HOURS (see
  // lib/fairness-config.ts's doc comment for the full priority-order
  // rationale). Real hours already scheduled for each employee THIS
  // WINDOW/week, used ONLY to break ties within the "recommended" group
  // when config.fairness_weights.workloadHoursWeight > 0 — never to
  // exclude or downgrade anyone, and never consulted at all while the
  // weight is 0 (the default). Defaults to an empty map so every existing
  // caller/test keeps working unchanged.
  hoursScheduledThisWindow: Map<string, number> = new Map(),
  // TASK-COUNT FAIRNESS (2026-10-03 demo milestone — see
  // lib/fairness-config.ts's doc comment for the confirmed, enabled-by-
  // default priority this sits at, ahead of the hours/fatigue keys
  // below). Per-employee count of comparable tasks/duties ALREADY
  // ASSIGNED in the current scope (e.g. this day/shift period) — used
  // PURELY to break ties among otherwise equally-suitable "recommended"
  // candidates when config.fairness_weights.taskCountWeight > 0: fewer
  // tasks already assigned first. Never an exclusion, never consulted at
  // all while the weight is 0, and never able to move a "flagged"
  // candidate ahead of a "recommended" one. Defaults to an empty map so
  // every existing caller/test keeps working unchanged (though the
  // default weight is now 1 — see DEFAULT_FAIRNESS_WEIGHTS — an empty map
  // still means "no known tasks yet", a neutral 0 for everyone, which is
  // a genuine no-op whenever every candidate is equally novel).
  tasksAssignedThisScope: Map<string, number> = new Map(),
  // FATIGUE BURDEN AS A SEPARATE SOFT DIMENSION (2026-09-24, fatigue
  // milestone part 2 — see lib/fairness-config.ts's doc comment for where
  // it sits relative to workloadHoursWeight). Each candidate's recent
  // fatigue state + the config it came from. Consulted ONLY when
  // config.fairness_weights.fatigueWeight > 0 AND `fatigue.config.enabled`
  // — and then only to order candidates WITHIN the "recommended" group,
  // after the workload-hours key. Never an exclusion: every hard gate
  // above runs first and is untouched. Omitted (the default) = exact prior
  // behaviour, no fatigueReason key.
  fatigue?: CandidateFatigueInput,
  // FULL SHIFT CONTAINMENT TARGET (2026-10-04 planning-integrity audit fix)
  // — the REAL operational task window a candidate's shift must fully
  // contain (task.start >= shift.start AND task.end <= shift.end) to be
  // automatically "recommended". Defaults to `window` above, which is
  // correct for every existing caller EXCEPT duty-generation.ts's
  // company_config clustering path: there, `window` is deliberately the
  // WIDE foreign-company protected window (~4h30 before departure, see
  // computeForeignCompanyProtectedWindow) used only to decide
  // busy/overlap conflicts correctly (the 2026-09-22 Gulf Air/Qatar
  // Airways double-booking fix) -- it is NOT the real task the employee
  // performs, and must never be what shift containment is judged against
  // (that would wrongly demand a shift starting 4h30 before departure for
  // a ~30-minute foreign-carrier task). `taskWindow` lets a caller keep
  // `window` wide for conflict purposes while still checking containment
  // against the real, narrow, DISPLAYED requirement window
  // (getRequirementWindow's own return value) — see duty-generation.ts's
  // call site for the one place this actually differs from `window`.
  taskWindow: TimeWindow = window
): CandidateResult[] {
  const eligiblePool = employees.filter((e): e is RosteredEmployee => {
    if (!e.active) return false;
    if (!hasRosterAssigned(e)) return false;
    if (e.is_duty_officer) return false;
    if (isFixedPlanningTeam(e.assignment)) return false;
    if (isTransitTeam(e.assignment) && role !== "Transit") return false;
    if ((occupiedWindows[e.id] ?? []).some((occupied) => windowsOverlap(occupied, window))) return false;
    // Hard ENTRY gate (not the full containment test): a candidate whose
    // shift doesn't overlap the requirement's window AT ALL is not "a shift
    // extension away" from covering it -- they are simply not working
    // anywhere near this flight, and must never enter scoring at all, not
    // even flagged. A candidate whose shift PARTIALLY overlaps (a late end
    // or an early start -- see extensionNeeded/earlyStartNeeded below)
    // still enters scoring, but is downgraded to FLAGGED, never
    // "recommended" -- see those checks below for the full containment
    // test that actually decides automatic eligibility.
    if (!windowsOverlap(window, { start: e.shift_start, end: e.shift_end })) return false;
    if (requiredAuthorization) return e.foreign_company_authorizations.includes(requiredAuthorization);
    return e.skills.includes(role);
  });

  const results: CandidateResult[] = eligiblePool.map((employee) => {
    const shiftEndMin = timeToMinutes(employee.shift_end);
    const taskWindowEndMin = timeToMinutes(taskWindow.end);
    // FULL SHIFT CONTAINMENT (2026-10-04 planning-integrity audit fix):
    // automatic generation requires task.start >= shift.start AND task.end
    // <= shift.end -- anything short of that is a genuine unplanned
    // exception (an early call-in or a shift extension), never an ordinary
    // planning option the automatic weekly planner may rely on to make a
    // plan "feasible". Before this fix, only the END boundary was checked
    // here (extensionNeeded) -- a shift starting AFTER the window opened
    // (e.g. a 05:45-14:45 shift against a 05:30-06:30 duty window) passed
    // through as fully "recommended", no flag at all, because the window
    // and shift do genuinely overlap (the hard eligiblePool gate above only
    // rejects TOTAL non-overlap) and the shift still reached departure.
    // That is exactly how ATLAS silently auto-assigned employees to duties
    // starting before their shift began (the Sanaa Benali/AT2101 and
    // Youssef El Amrani/AT2101 cases from the audit — 50 such violations
    // found across a real month of generated duties, systemic, not
    // isolated to one employee or flight). Both boundaries are now
    // checked symmetrically via the shared isWindowWithinShift predicate
    // (also used by lib/live-ops-service.ts to detect the same violation
    // on an already-assigned INCUMBENT after a live delay) -- a partial
    // overlap on EITHER boundary still enters scoring (so a human can see
    // and explicitly override it via Find Agent's "Assign with override"),
    // but is never auto-"recommended" by draft/duty generation, which only
    // ever auto-assigns "recommended" candidates (see
    // lib/planning/duty-generation.ts's own doc comment).
    const extensionNeeded = shiftEndMin < taskWindowEndMin;
    const earlyStartNeeded = timeToMinutes(employee.shift_start) > timeToMinutes(taskWindow.start);
    // isWindowWithinShift(taskWindow, employee.shift_start, employee.shift_end) is
    // exactly !extensionNeeded && !earlyStartNeeded here (both boundaries
    // already known non-null -- hasRosterAssigned guarantees it) -- kept as
    // two separate booleans only so the human-facing reasoning below can
    // name which boundary actually failed.
    // maximum_average_weekly_working_hours (42h) is a confirmed AVERAGE,
    // not a Monday-Sunday ceiling (see lib/labor-rules.ts) — the exact
    // reference period it averages over is not yet confirmed, so nothing
    // in this codebase can currently determine hard compliance from
    // Employee.weekly_hours alone (see lib/planning/average-hours.ts).
    // This remains a soft, human-review-only heuristic: an employee
    // already accumulating hours close to the confirmed average is worth
    // a second look before adding more, but this NEVER hard-excludes a
    // candidate, and no code elsewhere in the pipeline hard-rejects on
    // this basis any more either (see the delivered report on the
    // removed calendar-week 42h gate).
    const nearCeiling = employee.weekly_hours >= config.maximum_average_weekly_working_hours - 5;
    const rested = employee.rest_before_shift_hours >= config.minimum_rest_hours;

    // Eligibility basis, stated honestly: a real trained skill for every
    // ordinary role, or a real company authorization for a foreign-carrier
    // requirement — never the same "qualified" phrasing for both, since
    // authorization isn't a flight-task skill.
    const eligibilityBasis = requiredAuthorization ? `${requiredAuthorization}-authorized` : `${role}-qualified`;

    if (rested && !extensionNeeded && !earlyStartNeeded && !nearCeiling) {
      return {
        employee,
        status: "recommended",
        reasoning: `Currently on shift (${employee.shift_start}–${employee.shift_end}), ${eligibilityBasis}. ${employee.rest_before_shift_hours}h rest before shift (minimum required: ${config.minimum_rest_hours}h). Weekly hours: ${employee.weekly_hours}h — within the confirmed ${config.maximum_average_weekly_working_hours}h average. Shift fully covers the duty window, no early call-in or extension required.`,
      };
    }

    const reasons: string[] = [];
    if (earlyStartNeeded) reasons.push("would require an early call-in, before the shift begins, with no rest window");
    if (extensionNeeded) reasons.push("would require an unplanned shift extension with no rest window");
    if (nearCeiling) reasons.push(`weekly hours (${employee.weekly_hours}h) approaching the confirmed ${config.maximum_average_weekly_working_hours}h average`);
    if (!rested) reasons.push(`insufficient rest (${employee.rest_before_shift_hours}h, below the ${config.minimum_rest_hours}h minimum required)`);

    return {
      employee,
      status: "flagged",
      reasoning: `${eligibilityBasis}, but ${reasons.join("; ")}. Requires Duty Officer override to assign.`,
    };
  });

  const fatigueActive = (config.fairness_weights.fatigueWeight ?? 0) > 0 && fatigue?.config.enabled === true;

  const sorted = results.sort((a, b) => {
    if (a.status !== b.status) return a.status === "recommended" ? -1 : 1;
    // Task-count fairness tie-break — soft objective #4, evaluated BEFORE
    // the hours/fatigue keys below (see fairness-config.ts's priority
    // chain; this is the one enabled-by-default dimension, since the
    // business has confirmed raw task-count distribution as wanted demo
    // behavior). Gated behind a non-zero weight; Array.prototype.sort is
    // stable, so this is a genuine no-op (not an approximation) whenever
    // the weight is 0 or every candidate's count ties. Only compares
    // within the same status group — a "flagged" candidate never gets
    // reordered relative to a "recommended" one by this signal.
    if ((config.fairness_weights.taskCountWeight ?? 0) > 0) {
      const countA = tasksAssignedThisScope.get(a.employee.id) ?? 0;
      const countB = tasksAssignedThisScope.get(b.employee.id) ?? 0;
      if (countA !== countB) return countA - countB; // fewer already-assigned comparable tasks first
    }
    // Hours-based fairness tie-break — soft objective #4b in the priority
    // chain (see fairness-config.ts). Gated behind a non-zero weight so
    // the default (0) reproduces today's stable, input-order result
    // exactly; Array.prototype.sort is stable, so returning 0 here for
    // every pair when the weight is 0 is a genuine no-op, not an
    // approximation. Only compares within the same status group — a
    // "flagged" candidate never gets reordered relative to a
    // "recommended" one by this signal.
    if (config.fairness_weights.workloadHoursWeight > 0) {
      const hoursA = hoursScheduledThisWindow.get(a.employee.id) ?? 0;
      const hoursB = hoursScheduledThisWindow.get(b.employee.id) ?? 0;
      if (hoursA !== hoursB) return hoursA - hoursB; // fewer scheduled hours first
    }
    // Fatigue-burden key (4c) — a SEPARATE dimension from hours above (see
    // fairness-config.ts), only among recommended candidates (a flagged
    // pair keeps its stable order), never an exclusion.
    if (fatigueActive && a.status === "recommended") {
      const burdenA = rankingBurden(fatigue!.statesByEmployee.get(a.employee.id));
      const burdenB = rankingBurden(fatigue!.statesByEmployee.get(b.employee.id));
      if (burdenA !== burdenB) return burdenA - burdenB; // lower recent burden first
    }
    return 0;
  });

  if (fatigueActive) {
    // Explainability: each recommended candidate vs the next-ranked
    // recommended one (labels only — never a raw number).
    const recommended = sorted.filter((r) => r.status === "recommended");
    const stateOf = (id: string) => fatigue!.statesByEmployee.get(id) ?? unknownFatigueState("No recent fatigue history supplied for this candidate.");
    recommended.forEach((r, i) => {
      const next = recommended[i + 1];
      r.fatigueReason = explainFatigueFactors(stateOf(r.employee.id), { comparedWith: next ? stateOf(next.employee.id) : undefined, config: fatigue!.config });
    });
  }
  return sorted;
}
