import { Employee, StaffingRequirement, Config } from "../types";
import { getShiftTimesAs, getShiftDurationHours } from "../shift-templates";
import { flightDateFor, shiftWeek } from "../flight-date";
import { restHoursBetween } from "../roster-generation";
import { evaluateAverageWorkingHours } from "./average-hours";
import { usesFixedCycleRotation } from "../teams";
import { checkConsecutiveOffCyclic, checkOffDaysSeparated } from "./consecutive-off";
import { CapAwareRosterTarget } from "./roster-target";
// JR_NT_OFF_OFF_CYCLE is imported directly (not looked up per-team) because
// every fixed-cycle team today shares this one confirmed cycle definition
// (see lib/teams.ts's FIXED_CYCLE_TEAMS and lib/employee-generator.ts's
// FIXED_CYCLE_GROUPS). If a second, distinct fixed cycle is ever confirmed
// for a different team, this becomes a real per-team lookup then — not
// invented speculatively now.
import { JR_NT_OFF_OFF_CYCLE, maxConsecutiveOffInCycle } from "../fixed-cycle-rotation";
import { isGenerationDrivenPopulation } from "./workforce-pools";

// "needs_configuration" was REMOVED from this type entirely — it isn't an
// operational planning problem, it's an internal administrative gap (no
// RAM staffing-matrix rule for some aircraft/destination combination). It
// used to be folded in here and then filtered back out downstream, which
// left it one refactor away from silently inflating the operational Plan
// Warnings count again. It's now a fully separate concept — see
// ConfigurationIssue and collectConfigurationIssues below — with its own
// field on DraftWeeklyPlan, never mixed into this array.
//
// "cross_week_continuity_uncertain" is distinct from "rest_violation" on
// purpose: both come from the SAME wraparound check (this displayed
// week's own last day treated as if it repeated as the day before this
// week's own first day), but for a DEMAND-DRIVEN population (General T1,
// Profiling, Mesure, foreign companies) that assumption is a hypothesis
// about a week that hasn't been planned yet, never a confirmed fact —
// unlike a genuinely fixed/cyclic team (Transit/Leaders/Duty Officers),
// whose repeating pattern really is the confirmed rule. Treating the
// hypothesis as a hard, blocking rest_violation would silently drop real,
// otherwise-legal coverage over an assumption nobody has confirmed; this
// type surfaces the same finding as a visible, non-blocking warning
// instead (see checkRestBetweenDays and enforceRestInvariantAcrossWeek's
// own doc comments for the full reasoning).
// "separated_off_days" is a NEW, SOFT, non-blocking recommendation (Part
// 2 of the product owner's confirmed guidance) — distinct from the hard
// `consecutive_off_violation` above (the unrelated max-2-consecutive-OFF
// ceiling, unchanged). It flags a normal flexible employee whose two
// (config.normal_weekly_off_days) OFF days in this displayed window are
// legal but SEPARATED rather than one consecutive block — never a
// validation failure, just a recommendation surfaced in Plan Warnings so
// a planner can see it and decide whether operational reality justifies
// it (see lib/planning/consecutive-off.ts's checkOffDaysSeparated and
// roster-generation.ts's own consecutive-OFF preference, which already
// tries to avoid this outcome whenever legally possible).
export type PlanIssueType =
  | "unfilled_duty"
  | "rest_violation"
  | "weekly_hours_violation"
  | "consecutive_off_violation"
  | "cross_week_continuity_uncertain"
  | "separated_off_days"
  // HARD WORK CAPS (2026-09-25, hard-constraints milestone phase 1): a
  // NON-BLOCKING informational note — never a violation. Emitted once per
  // plan by generate-draft-plan.ts when some generation-driven employee's
  // consecutive-work-day history before this week is unknown (no
  // predecessor plan), so the hard 5-consecutive-work-day cap had to start
  // their count at 0 this week (see consecutive-days-continuity.ts's
  // incomingStreakForHardCap for the policy and its tradeoff).
  | "consecutive_work_history_unknown"
  // CAP-AWARE ROSTER TARGET (2026-09-25, hard-constraints milestone phase 2
  // part A — roster-target.ts): a NON-BLOCKING finding for a flexible-pool /
  // foreign-company employee rostered FEWER days than their own cap-aware
  // target — i.e. fewer than the hard weekly hours cap left room for at
  // their real shift codes. A week the cap itself limits (e.g. 4 x 9h, a 5th
  // day would exceed 42h) meets its target and is NOT flagged: it is that
  // employee's normal week.
  | "roster_target_shortfall";

export interface PlanIssue {
  type: PlanIssueType;
  description: string;
  requirementId?: string;
  employeeId?: string;
  dayOfWeek?: string;
}

/**
 * An internal administrative/configuration gap — NOT an operational
 * planning problem. "Plan Warnings" (rest violations, weekly-hours
 * violations, consecutive-OFF violations, unfilled duties) describe
 * something wrong with THIS WEEK'S generated plan; a ConfigurationIssue
 * describes something missing from ATLAS's own RULEBOOK (no RAM staffing-
 * matrix entry for an aircraft/destination combination, or an
 * unclassifiable destination) — true regardless of which week you're
 * looking at, and never something a planner can "fix" by reassigning
 * someone. Kept in its own array so nothing downstream can accidentally
 * fold it into the operational summary again; a future Administration/
 * Configuration area is the natural place to surface these, not the
 * routine weekly Plan Warnings count.
 */
export interface ConfigurationIssue {
  requirementId: string;
  description: string;
}

/**
 * Collects every StaffingRequirement still marked needs_configuration —
 * always non-empty-reasoning, never a guessed rule. Kept separate from
 * validateWeeklyPlan (which computes true operational Plan Warnings) so
 * the two can never be accidentally merged into one count again.
 */
export function collectConfigurationIssues(requirements: StaffingRequirement[]): ConfigurationIssue[] {
  return requirements
    .filter((r) => r.needs_configuration)
    .map((r) => ({ requirementId: r.id, description: r.reasoning }));
}

/**
 * Checks rest between each pair of CONSECUTIVE working days in
 * daysOrder, PLUS the cyclic Sunday -> following-Monday boundary — a
 * genuinely week-level check, distinct from the existing single-day
 * "would need a shift extension" logic in scoring.ts. Returns one issue
 * per violation found.
 *
 * Any pair of working days separated by one or more OFF days in between
 * is never at risk here: a full OFF day is always >= 24h of separation
 * once the OFF day's own bracketing shifts are accounted for, comfortably
 * clearing the confirmed 15h floor, so this only needs to check
 * CALENDAR-ADJACENT working-day pairs (today -> tomorrow) — exactly what
 * the index loop below does. The one gap that calendar-adjacency inside a
 * single Monday-Sunday window misses entirely is the week boundary
 * itself: this week's Sunday shift and NEXT week's Monday shift are also
 * calendar-adjacent in a continuously-operating roster (Transit/Leaders'
 * fixed JR->NT->OFF->OFF cycle, most notably), so that pair is checked
 * explicitly too, exactly like lib/planning/consecutive-off.ts's own
 * cyclic (week-wrapping) consecutive-OFF check.
 */
export function checkRestBetweenDays(employee: Employee, daysOrder: string[], config: Config, weekStart: string): PlanIssue[] {
  const issues: PlanIssue[] = [];

  function checkPair(todayLabel: string, tomorrowLabel: string, tomorrowIssueDay: string, issueType: PlanIssueType): void {
    const today = employee.weekly_shifts.find((s) => s.day_of_week === todayLabel);
    const tomorrow = employee.weekly_shifts.find((s) => s.day_of_week === tomorrowLabel);
    if (today?.status !== "working" || !today.shift_code) return;
    if (tomorrow?.status !== "working" || !tomorrow.shift_code) return;

    // The cyclic wrap pair (this week's last day -> the FOLLOWING week's
    // first day) needs the following week's real date, not this week's —
    // detected by tomorrowLabel appearing earlier in daysOrder than
    // todayLabel (the wrap case, handled below), otherwise both days share
    // this same weekStart's week.
    const todayIndex = daysOrder.indexOf(todayLabel);
    const tomorrowIndex = daysOrder.indexOf(tomorrowLabel);
    const isWrap = tomorrowIndex !== -1 && tomorrowIndex < todayIndex;
    const todayDate = flightDateFor(weekStart, todayLabel);
    const tomorrowDate = isWrap
      ? flightDateFor(shiftWeek(weekStart, 1), tomorrowLabel)
      : flightDateFor(weekStart, tomorrowLabel);

    const todayShift = getShiftTimesAs(today.shift_code, todayDate);
    const tomorrowShift = getShiftTimesAs(tomorrow.shift_code, tomorrowDate);

    // restHoursBetween needs the PREVIOUS shift's own start too, not just
    // its end -- an overnight previous shift (e.g. AP03 17:45-02:00) ends
    // on the FOLLOWING calendar day already, and clock-time subtraction
    // alone (treating "02:00" as if it were still today) would silently
    // overcount rest by a full 24h. See roster-generation.ts's
    // restHoursBetween doc comment.
    const restHours = restHoursBetween(todayShift.shift_start, todayShift.shift_end, tomorrowShift.shift_start);

    if (restHours < config.minimum_rest_hours) {
      const isWarning = issueType === "cross_week_continuity_uncertain";
      issues.push({
        type: issueType,
        employeeId: employee.id,
        dayOfWeek: tomorrowIssueDay,
        description: isWarning
          ? `${employee.name}: only ${restHours.toFixed(1)}h rest between ${todayLabel} (ends ${todayShift.shift_end}) and ${tomorrowLabel} (starts ${tomorrowShift.shift_start}) IF next week repeats this week's pattern — unconfirmed, since next week hasn't been planned yet. Review before publishing if you already know next week's actual schedule will put this employee on an early shift.`
          : `${employee.name}: only ${restHours.toFixed(1)}h rest between ${todayLabel} (ends ${todayShift.shift_end}) and ${tomorrowLabel} (starts ${tomorrowShift.shift_start}) — minimum required is ${config.minimum_rest_hours}h.`,
      });
    }
  }

  for (let i = 0; i < daysOrder.length - 1; i++) {
    checkPair(daysOrder[i], daysOrder[i + 1], daysOrder[i + 1], "rest_violation");
  }
  // Cyclic week-boundary pair: this week's last day -> next week's first
  // day (e.g. Sunday -> the following Monday), relevant to any
  // continuously-operating roster whose pattern doesn't reset at the
  // display week's edge. Only meaningful when daysOrder is the FULL
  // 7-day week (so "wrap to index 0" really means "the following
  // Monday") -- a partial slice (e.g. two arbitrary adjacent days passed
  // directly in a unit test) has no real "following week" boundary at
  // its end, and must not be treated as one.
  //
  // Issue type depends on WHICH population this employee belongs to: for
  // a fixed/cyclic team (Transit/Leaders/Duty Officers), this week's
  // pattern genuinely IS next week's pattern by confirmed design, so a
  // conflict here is a real, confirmed rest_violation — unchanged. For a
  // demand-driven population (General T1, Profiling, Mesure, foreign
  // companies), next week's actual schedule is generated fresh from next
  // week's own flight demand and is NOT yet known — "this week repeats"
  // is an unconfirmed assumption, so a conflict here is surfaced as the
  // softer cross_week_continuity_uncertain warning instead (see
  // enforceRestInvariantAcrossWeek's matching doc comment: that function
  // no longer silently drops this case for a demand-driven employee, so
  // this check is what actually surfaces it, visibly, in the final plan).
  if (daysOrder.length === 7) {
    const issueType: PlanIssueType = isGenerationDrivenPopulation(employee) ? "cross_week_continuity_uncertain" : "rest_violation";
    checkPair(daysOrder[daysOrder.length - 1], daysOrder[0], `${daysOrder[0]} (following week)`, issueType);
  }

  return issues;
}

/**
 * NOTE on naming: this still returns "hours scheduled in the displayed
 * week" — a real, useful DIAGNOSTIC number — but it is NOT, by itself,
 * sufficient to determine 42h AVERAGE compliance (see
 * lib/labor-rules.ts's maximumAverageWeeklyWorkingHours and
 * lib/planning/average-hours.ts). A single high or low displayed week is
 * expected and valid for a continuous rotation; only evaluateAverageWorkingHours
 * against a real, confirmed reference period can say whether the
 * employee's actual average is in or out of bounds. Kept under its
 * original name (rather than renamed) since it is still exactly what it
 * always computed — a per-displayed-week sum — just no longer treated
 * elsewhere as a compliance verdict on its own.
 */
export function computeScheduledWeeklyHours(employee: Employee, weekStart: string): number {
  let totalHours = 0;
  for (const entry of employee.weekly_shifts) {
    if (entry.status !== "working" || !entry.shift_code) continue;
    totalHours += getShiftDurationHours(entry.shift_code, flightDateFor(weekStart, entry.day_of_week));
  }
  return Math.round(totalHours * 10) / 10;
}

/**
 * Confirmed constraint (see lib/labor-rules.ts's
 * maximumAverageWeeklyWorkingHours, 42h) — but it is an AVERAGE over a
 * reference period that is NOT YET CONFIRMED
 * (config.working_hours_reference_period_days is null), never a
 * Monday-Sunday calendar-week ceiling. A single displayed week's total
 * exceeding (or staying under) 42h is NOT, by itself, a violation or a
 * pass of this rule — normal employee rosters are a continuous rotation
 * across week boundaries, and the display week is only a slice of it.
 *
 * This function therefore delegates to evaluateAverageWorkingHours
 * (lib/planning/average-hours.ts), which returns `not_evaluable` while
 * the reference period is unconfigured. It emits a PlanIssue ONLY when
 * that evaluator returns a real `violation` against a real, confirmed
 * period — which cannot happen today, by design, until management
 * confirms the period. This is deliberate: it is preferable to under-warn
 * here than to keep emitting a false weekly_hours_violation computed
 * against the wrong reference period. See auditAverageWeeklyHoursFeasibility
 * below for the equivalent configuration-level (non-per-week) treatment.
 */
export function checkAverageWeeklyHours(employee: Employee, config: Config, weekStart: string): PlanIssue | null {
  const scheduled = computeScheduledWeeklyHours(employee, weekStart);
  const daysCoveredThisWeek = employee.weekly_shifts.length;
  const result = evaluateAverageWorkingHours(scheduled, daysCoveredThisWeek, config);
  if (result.status !== "violation") return null;
  return {
    type: "weekly_hours_violation",
    employeeId: employee.id,
    description: `${employee.name}: averages ${result.averageWeeklyHours}h/week over the confirmed ${result.referencePeriodDays}-day reference period, above the confirmed ${config.maximum_average_weekly_working_hours}h average ceiling.`,
  };
}

/**
 * A CONFIGURATION-level feasibility audit (see ConfigurationIssue's doc
 * comment above) for the confirmed 42h AVERAGE ceiling — the counterpart
 * to auditStaticShiftRestFeasibility below, but for hours. Like
 * checkAverageWeeklyHours above, this can only emit a real violation once
 * a reference period is confirmed (config.working_hours_reference_period_days
 * is not null); until then it always returns an empty array — this is
 * the correct, honest behavior, not a bug: an employee's fixed weekly
 * pattern totaling, say, 46h in ONE displayed week is not evidence of an
 * average-hours violation over an unconfirmed longer period, and must
 * not be reported as a capacity gap on that basis alone (see the
 * delivered report for the numbers this replaces).
 *
 * This function is written against the general evaluator so that once a
 * real reference period IS confirmed, it starts producing real findings
 * with no further code change here — only lib/labor-rules.ts's
 * workingHoursReferencePeriodDays needs to change.
 */
export function auditAverageWeeklyHoursFeasibility(
  employees: Employee[],
  isFlexible: (e: Employee) => boolean,
  config: Config,
  weekStart: string
): ConfigurationIssue[] {
  if (config.working_hours_reference_period_days === null) return [];

  const issues: ConfigurationIssue[] = [];
  for (const employee of employees) {
    if (isFlexible(employee)) continue; // day-by-day generation already enforces this for these, at selection time
    const scheduled = computeScheduledWeeklyHours(employee, weekStart);
    const result = evaluateAverageWorkingHours(scheduled, employee.weekly_shifts.length, config);
    if (result.status === "violation") {
      issues.push({
        requirementId: `capacity-${employee.id}`,
        description: `${employee.name} (${employee.assignment}): fixed weekly pattern averages ${result.averageWeeklyHours}h/week over the confirmed ${result.referencePeriodDays}-day reference period, above the confirmed ${config.maximum_average_weekly_working_hours}h ceiling, with no per-day shift variation available to reduce it without adding an OFF day beyond the confirmed entitlement. Requires either a shorter compatible shift code for this role or a workforce-design decision — not something ATLAS can resolve automatically.`,
      });
    }
  }
  return issues;
}

/**
 * The same CONFIGURATION-level treatment as auditAverageWeeklyHoursFeasibility
 * above, but for the confirmed 15h minimum inter-shift rest rule instead
 * of the 42h average. An employee whose weekly schedule isn't decided
 * day-by-day during generation (anyone outside the flexible General T1
 * pool) simply repeats the SAME shift code on every working day with no
 * OFF day in between (Monday->Tuesday, Tuesday->Wednesday, etc.) — if
 * that single code's own day-to-day rest gap (24h - duration) falls
 * below the confirmed 15h floor, no day-by-day choice generation could
 * ever have made would fix it: the code itself is the problem, exactly
 * like an over-long shift code is for the 42h ceiling. This is a
 * genuine workforce-design/capacity gap, not a per-week Plan Warning
 * "surprise" and not something to silently resolve by inventing a new
 * shift code or an extra OFF day.
 *
 * NOTE: this only audits the EMPLOYEE'S OWN in-place repeating pattern
 * (checkRestBetweenDays against their static weekly_shifts) — it is
 * distinct from, and does not replace, checkRestBetweenDays being run
 * as a per-week PlanIssue against every employee (flexible included) in
 * validateWeeklyPlan, which is what actually surfaces this to the
 * routine Weekly Planning UI today.
 */
export function auditStaticShiftRestFeasibility(
  employees: Employee[],
  isFlexible: (e: Employee) => boolean,
  config: Config,
  weekStart: string
): ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  for (const employee of employees) {
    if (isFlexible(employee)) continue; // day-by-day generation already enforces this rule for these, at selection time
    const daysOrder = employee.weekly_shifts.map((s) => s.day_of_week);
    const restIssues = checkRestBetweenDays(employee, daysOrder, config, weekStart);
    if (restIssues.length > 0) {
      const worst = restIssues.reduce((min, i) => {
        const m = i.description.match(/only ([\d.]+)h rest/);
        const hours = m ? parseFloat(m[1]) : Infinity;
        return hours < min ? hours : min;
      }, Infinity);
      issues.push({
        requirementId: `rest-capacity-${employee.id}`,
        description: `${employee.name} (${employee.assignment}): fixed weekly pattern's repeating shift code yields as little as ${worst}h rest between consecutive working days, below the confirmed ${config.minimum_rest_hours}h minimum, with no per-day shift variation available to fix it. Requires either a different compatible shift code for this role or a workforce-design decision — not something ATLAS can resolve automatically.`,
      });
    }
  }
  return issues;
}

/**
 * Confirmed labor-rule constraint: max CONSECUTIVE OFF days (resolved via
 * config.max_consecutive_off_days — see lib/labor-rules.ts), evaluated
 * across week boundaries (see lib/planning/consecutive-off.ts).
 *
 * A team on a confirmed continuous FIXED CYCLE (Transit/Leaders — see
 * lib/fixed-cycle-rotation.ts) is period-4, not period-7, so wrapping
 * their single displayed Monday-Sunday snapshot onto itself would
 * misrepresent their real continuous schedule. They are still subject to
 * the SAME resolved labor protection, though — not skipped outright: the
 * real continuous cycle's own maxConsecutiveOffInCycle is validated
 * against config.max_consecutive_off_days instead of the weekly snapshot.
 * The rotation policy (the JR->NT->OFF->OFF sequence itself) stays
 * entirely in lib/fixed-cycle-rotation.ts — this only checks that the
 * cycle SATISFIES the labor rule, never redefines or overrides it.
 */
export function checkConsecutiveOff(employee: Employee, config: Config): PlanIssue | null {
  if (usesFixedCycleRotation(employee.assignment)) {
    const cycleMax = maxConsecutiveOffInCycle(JR_NT_OFF_OFF_CYCLE);
    if (cycleMax > config.max_consecutive_off_days) {
      return {
        type: "consecutive_off_violation",
        employeeId: employee.id,
        description: `${employee.name}: the ${employee.assignment} fixed cycle has ${cycleMax} consecutive OFF days in its continuous rotation — above the confirmed maximum of ${config.max_consecutive_off_days}.`,
      };
    }
    return null;
  }
  const violation = checkConsecutiveOffCyclic(employee, config.max_consecutive_off_days);
  if (!violation) return null;
  return {
    type: "consecutive_off_violation",
    employeeId: employee.id,
    description: `${employee.name}: ${violation.maxConsecutiveOffDays} consecutive OFF days (evaluated across the week boundary) — above the confirmed maximum of ${config.max_consecutive_off_days}.`,
  };
}

/**
 * SOFT recommendation (Part 2, confirmed): a normal flexible employee's
 * two OFF days are legal either way, but consecutive is preferred where
 * operationally possible. Fixed-cycle teams (Transit/Leaders/Duty
 * Officers) are excluded, exactly like checkConsecutiveOff above — their
 * own confirmed rotation shape governs them, not this general preference.
 * Never returns anything for an employee outside the confirmed
 * normal-OFF-day count (see checkOffDaysSeparated's own doc comment).
 */
export function checkSeparatedOffDays(employee: Employee, daysOrder: string[], config: Config, rosterTarget?: CapAwareRosterTarget): PlanIssue | null {
  if (usesFixedCycleRotation(employee.assignment)) return null;
  // PART A (phase 2): a week whose target the hard hours cap lowered
  // (roster-target.ts — e.g. 4 work days, so 3 OFF) is that employee's
  // NORMAL week. Its OFF days cannot form one block without breaking the
  // hard max_consecutive_off_days rule (3 > 2), and where they fall is
  // largely dictated by the committed demand days — so the "one consecutive
  // block" preference does not apply and nothing is flagged here. A genuine
  // over-long OFF block is still the hard consecutive_off_violation, and a
  // week short of its own target is roster_target_shortfall (below).
  if (rosterTarget && rosterTarget.targetWorkDays < rosterTarget.normalTargetWorkDays) return null;
  const finding = checkOffDaysSeparated(employee, daysOrder, config.normal_weekly_off_days);
  if (!finding) return null;
  return {
    type: "separated_off_days",
    employeeId: employee.id,
    description: `${employee.name}: OFF days (${finding.offDays.join(", ")}) are legal but separated rather than one consecutive block — consecutive OFF days are preferred where operationally possible, though a separated pattern remains fully valid.`,
  };
}

/**
 * PART A (2026-09-25, hard-constraints milestone phase 2): the "normal
 * roster structure" check, now per employee. `rosterTarget` is the
 * employee's CAP-AWARE target (roster-target.ts): the normal
 * daysOrder.length - normal_weekly_off_days, or fewer when the hard weekly
 * hours cap cannot fit that many of their real codes.
 *
 * THE DISTINCTION THIS ENCODES (the crux of part A):
 *   - worked days == target (even when target < 5): NORMAL. A 4-work /
 *     3-OFF week forced by the 42h cap is not an anomaly and is not flagged.
 *   - worked days < target AND a hard cap closed a free day
 *     (rosterTarget.capClosedFreeDays): the hours arithmetic left room for
 *     more days than were rostered — a genuinely avoidable shortfall (an
 *     ordering artifact, e.g. the consecutive-work-day cap closing a day the
 *     hours cap allowed). Flagged, non-blocking.
 * No target (static/fixed-cycle/Profiling-Mesure employees, or a caller that
 * supplies none) = nothing to check.
 */
export function checkRosterTargetShortfall(employee: Employee, daysOrder: string[], rosterTarget?: CapAwareRosterTarget): PlanIssue | null {
  if (!rosterTarget || usesFixedCycleRotation(employee.assignment)) return null;
  // Only a HARD-CAP-attributable shortfall is flagged here (a free day the
  // arithmetic left room for was closed by a cap — typically the
  // consecutive-work-day cap, or an hours cap reached early by the greedy's
  // order). A shortfall with no cap involvement (15h rest left no legal code
  // on a free day) predates this milestone, is unaffected by it, and keeps
  // being surfaced exactly as before (e.g. consecutive_off_violation) — so a
  // plan whose caps never bind gets no new warning from this check.
  if ((rosterTarget.capClosedFreeDays?.length ?? 0) === 0) return null;
  const worked = daysOrder.filter((day) => {
    const entry = employee.weekly_shifts.find((s) => s.day_of_week === day);
    return entry?.status === "working" && Boolean(entry.shift_code);
  }).length;
  if (worked >= rosterTarget.targetWorkDays) return null;
  const basis = rosterTarget.capLimited
    ? `their cap-aware target is ${rosterTarget.targetWorkDays} (the ${rosterTarget.hardWeeklyHoursCap}h hard weekly hours cap cannot fit the normal ${rosterTarget.normalTargetWorkDays} at their real shift codes)`
    : `their target is the normal ${rosterTarget.targetWorkDays}, which the ${rosterTarget.hardWeeklyHoursCap}h hard weekly hours cap leaves room for`;
  return {
    type: "roster_target_shortfall",
    employeeId: employee.id,
    description: `${employee.name}: rostered ${worked} work day(s) this week but ${basis} — ${rosterTarget.targetWorkDays - worked} achievable day(s) were not rostered because a hard cap closed ${rosterTarget.capClosedFreeDays!.join(", ")}. Non-blocking.`,
  };
}

/**
 * Stage 10 of the planning pipeline. Deliberately does NOT include a
 * separate overlap detector — generateDutiesForDay already prevents
 * overlapping assignments by construction (proven by
 * tests/duty-generation.test.ts), so a post-hoc overlap check here would
 * be redundant for anything this pipeline itself produced. It would only
 * matter for externally-supplied duties, which this stage doesn't
 * receive.
 */
export function validateWeeklyPlan(
  unfilledByDay: { dayOfWeek: string; requirementId: string; role: string; stillNeeded: number }[],
  employees: Employee[],
  daysOrder: string[],
  config: Config,
  weekStart: string,
  // PART A (phase 2): each flexible-pool / foreign-company employee's
  // cap-aware roster target (generate-draft-plan.ts). Optional; omitted =
  // the pre-phase checks exactly.
  rosterTargets?: ReadonlyMap<string, CapAwareRosterTarget>
): PlanIssue[] {
  const issues: PlanIssue[] = [];

  // needs_configuration requirements are NOT this function's concern at
  // all any more — see collectConfigurationIssues above, called
  // separately (generate-draft-plan.ts) into its own DraftWeeklyPlan
  // field, so a configuration gap can never inflate the operational Plan
  // Warnings count again.

  for (const u of unfilledByDay) {
    issues.push({
      type: "unfilled_duty",
      requirementId: u.requirementId,
      dayOfWeek: u.dayOfWeek,
      description: `${u.role} requirement on ${u.dayOfWeek} still needs ${u.stillNeeded} more — no qualified, available, rested employee found. This requirement cannot currently be covered.`,
    });
  }

  for (const employee of employees) {
    issues.push(...checkRestBetweenDays(employee, daysOrder, config, weekStart));
    const hoursIssue = checkAverageWeeklyHours(employee, config, weekStart);
    if (hoursIssue) issues.push(hoursIssue);
    const consecutiveOffIssue = checkConsecutiveOff(employee, config);
    if (consecutiveOffIssue) issues.push(consecutiveOffIssue);
    const separatedOffIssue = checkSeparatedOffDays(employee, daysOrder, config, rosterTargets?.get(employee.id));
    if (separatedOffIssue) issues.push(separatedOffIssue);
    const targetIssue = checkRosterTargetShortfall(employee, daysOrder, rosterTargets?.get(employee.id));
    if (targetIssue) issues.push(targetIssue);
  }

  return issues;
}
