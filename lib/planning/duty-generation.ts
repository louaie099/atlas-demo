import { Employee, Flight, StaffingRequirement, Assignment, Config, WeeklyPlanRosterEntry } from "../types";
import { scoreCandidates, TimeWindow } from "../scoring";
import { getRequirementWindow } from "./requirement-window";
import { getEmployeeForeignCommitments, computeForeignCompanyProtectedWindow } from "../foreign-company-window";
import { GeneratedShiftAssignment, ActualRestHoursByEmployeeDay } from "./shift-generation";
import { getShiftTimesAs } from "../shift-templates";
import { isGenerationDrivenPopulation } from "./workforce-pools";

export interface GeneratedDuty {
  requirementId: string;
  flightId: string;
  employeeId: string;
  role: string;
  window: TimeWindow;
  reasoning: string;
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function windowsOverlap(a: TimeWindow, b: TimeWindow): boolean {
  return timeToMinutes(a.start) < timeToMinutes(b.end) && timeToMinutes(b.start) < timeToMinutes(a.end);
}

/**
 * Builds each employee's EFFECTIVE shift for a specific day.
 *
 * For a GENERATION-DRIVEN employee (isGenerationDrivenPopulation --
 * Stage 6's own flexible General T1 pool, UNCHANGED, plus Profiling/
 * Mesure and every foreign-company team, whose own roster is now also
 * derived fresh each run -- see specialized-team-generation.ts), the
 * day's outcome comes ENTIRELY from this run's generated shift for that
 * day -- there is no fallback to their static baseline `weekly_shifts`
 * code. That baseline is retained only as durable/legacy compatibility
 * data (see lib/types.ts's Employee doc comment) -- it must not dictate
 * an actual planned work/OFF day for any of these populations any more.
 * If generation didn't select this employee for this day, they are
 * genuinely OFF, exactly as demand (or, for a foreign company, that
 * day's real flight schedule) determined; that is a normal, expected
 * planning outcome, not something to paper over with a template shift.
 *
 * For every other employee (Transit/Leaders/Duty Officers' confirmed
 * fixed cycle, or any other still-static team), the existing
 * `weekly_shifts` entry IS their real, already-established commitment
 * under their own dedicated planning model and is used as-is --
 * generation never touches these employees, so nothing here changes for
 * them.
 */
export function effectiveShiftForDay(
  employee: Employee,
  dayOfWeek: string,
  generatedShifts: GeneratedShiftAssignment[],
  // The REAL calendar date ("YYYY-MM-DD") this dayOfWeek label refers to —
  // required so the correct effective-dated shift regime (see
  // lib/shift-templates.ts) is resolved for THIS specific day, never a
  // stale global catalog. Every real caller has this (a WeeklyPlan/draft
  // is always generated/read against a real weekStart) — see
  // lib/flight-date.ts's flightDateFor for how callers derive it.
  date: string
): { shift_start: string; shift_end: string } | null {
  if (isGenerationDrivenPopulation(employee)) {
    const generated = generatedShifts.find((g) => g.employeeId === employee.id && g.dayOfWeek === dayOfWeek);
    return generated ? getShiftTimesAs(generated.shiftCode, date) : null;
  }

  const existing = employee.weekly_shifts.find((s) => s.day_of_week === dayOfWeek);
  if (existing?.status === "off") return null;
  if (existing?.shift_code) return getShiftTimesAs(existing.shift_code, date);
  return null; // not rostered this day — never a candidate for a duty that day
}

/**
 * Same effective-shift logic as effectiveShiftForDay above, but returns the
 * shift CODE ("MT02") rather than resolved start/end times — what Agent
 * Schedule's day-by-day grid needs to display. Kept as a separate function
 * rather than changing effectiveShiftForDay's return shape, to avoid
 * touching that function's existing callers/tests.
 */
export function effectiveShiftCodeForDay(
  employee: Employee,
  dayOfWeek: string,
  generatedShifts: GeneratedShiftAssignment[]
): string | null {
  if (isGenerationDrivenPopulation(employee)) {
    const generated = generatedShifts.find((g) => g.employeeId === employee.id && g.dayOfWeek === dayOfWeek);
    return generated?.shiftCode ?? null;
  }

  const existing = employee.weekly_shifts.find((s) => s.day_of_week === dayOfWeek);
  if (existing?.status === "off") return null;
  return existing?.shift_code ?? null;
}

/**
 * Resolves ONE employee's plan-scoped roster entry for one day -- the
 * single function that produces what becomes a persisted
 * WeeklyPlanRosterEntry row (see lib/types.ts), for every employee group
 * alike (fixed-cycle, foreign-committed, flexible General T1 Pool). Same
 * effective-shift logic as effectiveShiftForDay/effectiveShiftCodeForDay
 * above, restated here to also produce the explicit "working"/"off"
 * status a roster row needs.
 *
 * For the FLEXIBLE pool, this is now the single authoritative
 * demand-driven answer: Stage 6's generated shift, or OFF — never a
 * re-read of `Employee.weekly_shifts` as a fallback (see
 * effectiveShiftForDay's doc comment above; that field is durable
 * compatibility/legacy data for this population now, not this week's
 * plan). For every other employee group, `weekly_shifts` remains their
 * real, already-established commitment, read as-is. Once persisted as a
 * WeeklyPlanRosterEntry, THAT row -- not a re-read of
 * Employee.weekly_shifts -- is what every later read of this plan must
 * use, for every employee group alike.
 */
export function resolvePlanRosterEntry(
  employee: Employee,
  dayOfWeek: string,
  generatedShifts: GeneratedShiftAssignment[]
): { status: "working" | "off"; shift_code: string | null } {
  if (isGenerationDrivenPopulation(employee)) {
    const generated = generatedShifts.find((g) => g.employeeId === employee.id && g.dayOfWeek === dayOfWeek);
    return generated ? { status: "working", shift_code: generated.shiftCode } : { status: "off", shift_code: null };
  }

  const existing = employee.weekly_shifts.find((s) => s.day_of_week === dayOfWeek);
  if (existing?.status === "off") return { status: "off", shift_code: null };
  if (existing?.shift_code) return { status: "working", shift_code: existing.shift_code };
  return { status: "off", shift_code: null }; // no roster entry at all for this day -- treated the same as off, matching AgentDayEntry's existing isOff semantics
}

/**
 * Same day-effective-pool gate generation itself uses (see
 * generateDutiesForDay below), but sourced from a PERSISTED
 * WeeklyPlanRosterEntry set instead of live Employee.weekly_shifts +
 * freshly-computed generated shifts. This is what the Find Agent
 * candidates API and the Assign API's server-side re-validation must use
 * instead of scoring raw Employee rows directly -- scoreCandidates alone
 * only checks that an employee HAS some shift profile (non-null
 * shift_start/shift_end), never whether they are actually working on the
 * specific day in question. Without this gate, a human could manually
 * assign an employee on their scheduled day off -- silently overriding a
 * fixed labor-rule protection (e.g. max consecutive off days) that ATLAS's
 * own generation is never allowed to violate. Excludes anyone with no
 * roster entry for the day or a status of "off"; everyone else gets their
 * shift_start/shift_end substituted from their persisted roster shift_code
 * so scoreCandidates' rest/extension math reflects THIS plan's actual
 * roster, not a stale static baseline.
 */
export function buildDayEffectivePoolFromRosterEntries(
  employees: Employee[],
  rosterEntries: WeeklyPlanRosterEntry[],
  dayOfWeek: string,
  // The real calendar date this dayOfWeek label refers to — see
  // effectiveShiftForDay's doc comment on the same parameter.
  date: string
): Employee[] {
  const byEmployee = new Map<string, WeeklyPlanRosterEntry>();
  for (const entry of rosterEntries) {
    if (entry.day_of_week === dayOfWeek) byEmployee.set(entry.employee_id, entry);
  }

  return employees
    .map((e) => {
      const entry = byEmployee.get(e.id);
      if (!entry || entry.status === "off" || !entry.shift_code) return null;
      const times = getShiftTimesAs(entry.shift_code, date);
      return { ...e, shift_start: times.shift_start, shift_end: times.shift_end } as Employee;
    })
    .filter((e): e is Employee => e !== null);
}

/**
 * Stage 9 of the planning pipeline: assigning actual flight duties, one
 * requirement at a time, ONLY after shifts for the day already make
 * sense (Stages 6–8 done). Requirements are processed in departure-time
 * order so that an employee assigned to an earlier duty is correctly
 * excluded from a later, overlapping one — busy windows accumulate
 * across the pass, reusing the exact same overlap-exclusion mechanism
 * scoreCandidates already uses for foreign commitments
 * (occupiedWindows), just fed by this function instead of only
 * getEmployeeForeignCommitments.
 *
 * Only "recommended" candidates are auto-assigned in the draft — a
 * "flagged" candidate (e.g. would need a shift extension, or is near the
 * fairness ceiling) is left for human review rather than silently
 * auto-picked, consistent with "ATLAS recommends, humans approve."
 */
/**
 * Every window a given day's already-persisted Assignments make an
 * employee unavailable for — the shared overlap-exclusion input for
 * scoreCandidates, used identically by duty-generation (draft-plan
 * generation), the Find Agent candidates API, and the Assign API's own
 * server-side re-validation, so the three can never drift apart.
 *
 * Two sources, both included:
 *  1. Foreign-company commitments (getEmployeeForeignCommitments) — the
 *     WIDER protected window (4h30 before departure), deliberately
 *     broader than the requirement's own window.
 *  2. EVERY other existing Assignment for the day, RAM or company_config
 *     alike, using that requirement's own window. This is what prevents
 *     an employee already confirmed for one requirement (Gate, say) from
 *     also being recommended/assignable to a different, overlapping
 *     requirement (Boarding) on the same or another flight that day —
 *     the "Sara Bennis on both Gate and Boarding" bug.
 */
export function computeBusyWindowsForDay(
  dayOfWeek: string,
  existingAssignments: Assignment[],
  requirements: StaffingRequirement[],
  flights: Flight[],
  allEmployees: Employee[],
  checkinPolicy?: import("./checkin-demand").CheckinDemandPolicy
): Record<string, TimeWindow[]> {
  const busyWindows: Record<string, TimeWindow[]> = {};

  for (const employee of allEmployees) {
    const commitments = getEmployeeForeignCommitments(employee.id, existingAssignments, requirements, flights).filter(
      (c) => c.dayOfWeek === dayOfWeek
    );
    if (commitments.length > 0) busyWindows[employee.id] = commitments.map((c) => c.window);
  }

  for (const assignment of existingAssignments) {
    const requirement = requirements.find((r) => r.id === assignment.staffing_requirement_id);
    if (!requirement) continue;
    const flight = flights.find((f) => f.id === requirement.flight_id);
    if (!flight || flight.day_of_week !== dayOfWeek) continue;
    const window = getRequirementWindow(requirement, flight, checkinPolicy);
    busyWindows[assignment.employee_id] = [...(busyWindows[assignment.employee_id] ?? []), window];
  }

  return busyWindows;
}

export function generateDutiesForDay(
  dayOfWeek: string,
  requirements: StaffingRequirement[],
  flights: Flight[],
  allEmployees: Employee[],
  generatedShifts: GeneratedShiftAssignment[],
  existingAssignments: Assignment[],
  config: Config,
  // The real calendar date this dayOfWeek label refers to — see
  // effectiveShiftForDay's doc comment on the same parameter. Required:
  // every real caller generates/reads against a real weekStart.
  date: string,
  // The single authoritative "actual rest before today's real shift"
  // source (see enforceRestInvariantAcrossWeek's own doc comment) --
  // when omitted, falls back to each employee's static persisted
  // rest_before_shift_hours (existing behavior), so every existing
  // caller/test keeps working unchanged. Real callers (generate-draft-
  // plan.ts) always pass this: an employee's REST ELIGIBILITY for a duty
  // must reflect the rest actually implied by their real generated/
  // persisted shift, never a stale value left over from whatever their
  // OLD static template happened to imply.
  actualRestHoursByDay?: ActualRestHoursByEmployeeDay,
  // Hours-based fairness input (see scoring.ts's own doc comment on its
  // `hoursScheduledThisWindow` parameter) — real hours already scheduled
  // per employee this week, from the plan's own generated roster.
  // Defaults to empty so every existing caller/test keeps working
  // unchanged; only relevant while config.fairness_weights.workloadHoursWeight
  // is non-zero.
  hoursScheduledThisWindow: Map<string, number> = new Map()
): { duties: GeneratedDuty[]; unfilled: { dayOfWeek: string; requirementId: string; role: string; stillNeeded: number }[] } {
  const dayFlightIds = new Set(flights.filter((f) => f.day_of_week === dayOfWeek).map((f) => f.id));
  const dayRequirements = requirements
    .filter((r) => dayFlightIds.has(r.flight_id) && !r.needs_configuration)
    .map((r) => {
      const flight = flights.find((f) => f.id === r.flight_id)!;
      return { requirement: r, flight, window: getRequirementWindow(r, flight, config.checkin_demand_policy) };
    });

  const busyWindows = computeBusyWindowsForDay(dayOfWeek, existingAssignments, requirements, flights, allEmployees, config.checkin_demand_policy);

  const duties: GeneratedDuty[] = [];
  const unfilled: { dayOfWeek: string; requirementId: string; role: string; stillNeeded: number }[] = [];

  // Build day-effective candidate pool ONCE: only employees actually
  // rostered this day, with their real shift for THIS day substituted
  // in — this is the day-aware reuse of scoreCandidates. rest_before_
  // shift_hours is ALSO substituted here, from the same authoritative
  // source as shift_start/shift_end are, for exactly the same reason:
  // an employee's real generated/persisted shift for today can differ
  // completely from whatever their static baseline template implied,
  // and eligibility must reflect the shift they're ACTUALLY on, not a
  // stale snapshot of a different one.
  const dayEffectivePool = allEmployees
    .map((e) => {
      const effective = effectiveShiftForDay(e, dayOfWeek, generatedShifts, date);
      if (!effective) return null;
      const actualRest = actualRestHoursByDay?.get(`${e.id}|${dayOfWeek}`);
      return {
        ...e,
        shift_start: effective.shift_start,
        shift_end: effective.shift_end,
        rest_before_shift_hours: actualRest ?? e.rest_before_shift_hours,
      } as Employee;
    })
    .filter((e) => e !== null) as Employee[];

  // STAGE 6 / STAGE 9 COHERENCE (see the delivered AT870 report): a fixed
  // processing order (departure time, or any other static category
  // order) is inherently order-dependent when multiple SIMULTANEOUS
  // requirements share a multi-qualified candidate pool -- whichever
  // requirement happens to be processed first greedily consumes shared
  // people, even when Stage 6 already secured EXACTLY enough distinct
  // total headcount to cover every one of them, because Stage 6's own
  // per-bucket accounting has no way to bind a specific employee to a
  // specific real per-flight requirement (it operates on a coarser,
  // aggregated bucket grid). A fixed order that happens to work for
  // today's data is not a fix -- the very next week's flight mix could
  // just as easily invert which requirement starves.
  //
  // The fix: group requirements into CLUSTERS of mutually-overlapping
  // real time windows (transitively -- if A overlaps B and B overlaps C,
  // all three compete for the same instant even if A and C don't overlap
  // each other directly), then within each cluster process requirements
  // in MOST-CONSTRAINED-FIRST order: whichever unfilled requirement
  // currently has the FEWEST eligible ("recommended") candidates is
  // resolved before any requirement with more options, recomputed after
  // every assignment (since a candidate pool can only shrink as other
  // requirements in the same cluster consume people, never grow). This
  // is the standard "smallest domain first" heuristic for exactly this
  // shape of problem (a set of simultaneous demands sharing a scarce,
  // multi-qualified pool) -- it makes the OUTCOME depend on genuine
  // scarcity, never on which category a role happens to be, so it
  // generalizes to any future flight mix rather than being tuned to
  // today's data. A requirement with no overlap with anything else that
  // day is simply a cluster of one -- unaffected, same result as before.
  //
  // Everything else is completely unchanged: scoreCandidates' own
  // ranking, rest/qualification/overlap eligibility, and busyWindows'
  // no-double-booking enforcement are all exactly as strict as before --
  // this only changes WHICH ORDER requirements are offered to the same
  // pool, never weakens what counts as eligible.
  // FIX (2026-09-22 — see docs/known-limitations/roster-planning-vs-duty-
  // allocation.md's audit finding #3): a company_config requirement's real
  // conflict window is the WIDE protected window
  // (computeForeignCompanyProtectedWindow, ~4h30 before departure) — the
  // SAME window computeBusyWindowsForDay already uses for busy-blocking —
  // not getRequirementWindow's narrow generic default (which falls
  // through to `departure-45min` to `departure-15min` for a foreign
  // flight, since it doesn't set boarding_window_start/end). Using the
  // narrow window here let a real double-booking through: an employee
  // could hold both a RAM Boarding duty and a foreign-company duty whose
  // real protected window swallowed the Boarding duty's operational
  // window, because the two requirements' narrow windows didn't overlap
  // even though the employee's real, physical unavailability windows did.
  //
  // `conflictWindows[i]` is used ONLY for this clustering overlap decision
  // and for the scoreCandidates call below (which is what actually decides
  // eligibility against `busyWindows`) — `dayRequirements[i].window`
  // itself (the requirement's own displayed/operational window, used for
  // the GeneratedDuty's stored `window` and its busyWindows entry for
  // OTHER, RAM requirements) is deliberately left unchanged. Investigated
  // and confirmed safe: getRequirementWindow's return value is still used
  // as-is for every RAM (fixed_rule/demand_forecast) requirement — this
  // only widens the conflict window for `company_config` sources, and
  // only for the two places that actually decide "does this employee
  // conflict with this company duty" (clustering + scoreCandidates), never
  // for what's persisted/displayed as the duty's own window.
  const conflictWindows: TimeWindow[] = dayRequirements.map(({ requirement, flight, window }) =>
    requirement.source === "company_config" ? computeForeignCompanyProtectedWindow(flight) : window
  );

  const n = dayRequirements.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (windowsOverlap(conflictWindows[i], conflictWindows[j])) union(i, j);
    }
  }
  const clusterMembers = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    clusterMembers.set(root, [...(clusterMembers.get(root) ?? []), i]);
  }
  // Deterministic cluster processing order (doesn't affect correctness --
  // clusters never share candidates by definition of "no window overlap"
  // -- only reproducibility): earliest window start, then lexically
  // smallest requirement id in the cluster.
  const clusters = Array.from(clusterMembers.values()).sort((a, b) => {
    const aMin = Math.min(...a.map((i) => timeToMinutes(dayRequirements[i].window.start)));
    const bMin = Math.min(...b.map((i) => timeToMinutes(dayRequirements[i].window.start)));
    if (aMin !== bMin) return aMin - bMin;
    const aId = a.map((i) => dayRequirements[i].requirement.id).sort()[0];
    const bId = b.map((i) => dayRequirements[i].requirement.id).sort()[0];
    return aId.localeCompare(bId);
  });

  for (const clusterIndices of clusters) {
    const remaining = new Set(clusterIndices);

    while (remaining.size > 0) {
      let bestIdx = -1;
      let bestRecommended: ReturnType<typeof scoreCandidates> = [];
      let bestStillNeeded = 0;

      for (const idx of remaining) {
        const { requirement, flight, window } = dayRequirements[idx];
        const alreadyAssignedToThisRequirement = existingAssignments.filter((a) => a.staffing_requirement_id === requirement.id).length;
        const stillNeeded = requirement.total_requirement - alreadyAssignedToThisRequirement - duties.filter((d) => d.requirementId === requirement.id).length;
        if (stillNeeded <= 0) {
          remaining.delete(idx);
          continue;
        }

        const requiredAuthorization = requirement.source === "company_config" ? flight.airline : undefined;
        // Uses conflictWindows[idx] (the wide protected window for a
        // company_config requirement, the requirement's own window for
        // everything else — see this function's comment above the
        // clustering pass) so a candidate's ALREADY-recorded busy windows
        // are checked against the employee's REAL unavailability for this
        // duty, not its narrow displayed window. This is what actually
        // decides eligibility/exclusion — the clustering fix alone only
        // orders processing; this is what closes the double-booking
        // regardless of which requirement in a cluster is resolved first.
        const results = scoreCandidates(requirement.role, conflictWindows[idx], dayEffectivePool, config, busyWindows, requiredAuthorization, hoursScheduledThisWindow);
        const recommended = results.filter((r) => r.status === "recommended");

        if (
          bestIdx === -1 ||
          recommended.length < bestRecommended.length ||
          (recommended.length === bestRecommended.length && requirement.id < dayRequirements[bestIdx].requirement.id)
        ) {
          bestIdx = idx;
          bestRecommended = recommended;
          bestStillNeeded = stillNeeded;
        }
      }

      if (bestIdx === -1) break; // every remaining requirement in this cluster already fully resolved above

      const { requirement, flight, window } = dayRequirements[bestIdx];
      let filled = 0;
      for (const candidate of bestRecommended) {
        if (filled >= bestStillNeeded) break;
        duties.push({
          requirementId: requirement.id,
          flightId: flight.id,
          employeeId: candidate.employee.id,
          role: requirement.role,
          window,
          reasoning: candidate.reasoning,
        });
        // The window recorded here is what makes this employee unavailable
        // to every LATER requirement resolved in this same day's pass (see
        // this loop's own busyWindows accumulation). For an ordinary
        // RAM/internal requirement, the requirement's own operational
        // window is correct and already matches computeBusyWindowsForDay's
        // pre-pass treatment of existing assignments. But a company_config
        // (foreign-carrier) requirement's real unavailability is the WIDER
        // protected window (4h30 before departure -- computeForeignCompany
        // ProtectedWindow, the same generic, airline-agnostic function
        // computeBusyWindowsForDay's own pre-pass already uses via
        // getEmployeeForeignCommitments for assignments made in EARLIER
        // calls/days). Recording only the narrow operational window here
        // let an employee assigned to one foreign company's duty earlier in
        // THIS SAME day's pass still look free for a different (or the
        // same) foreign company's later, protected-window-overlapping
        // requirement -- confirmed live as the Meriem/Noureddine Gulf
        // Air + Qatar Airways double-booking. Using the protected window
        // for company_config sources here closes that gap without
        // widening anything for RAM requirements, and without naming any
        // specific airline or employee.
        const busyWindow = requirement.source === "company_config" ? computeForeignCompanyProtectedWindow(flight) : window;
        busyWindows[candidate.employee.id] = [...(busyWindows[candidate.employee.id] ?? []), busyWindow];
        filled++;
      }

      // This requirement's own pool can only ever shrink further (other
      // requirements in the cluster only remove candidates, never add
      // any) -- once it's had its most-constrained-first turn and taken
      // everyone currently recommended, there is nothing left to gain by
      // revisiting it later, so it's resolved (filled or honestly
      // reported unfilled) in this one pass and removed from the cluster.
      if (filled < bestStillNeeded) {
        unfilled.push({ dayOfWeek, requirementId: requirement.id, role: requirement.role, stillNeeded: bestStillNeeded - filled });
      }
      remaining.delete(bestIdx);
    }
  }

  return { duties, unfilled };
}
