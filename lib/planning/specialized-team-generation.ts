import { Employee, Flight, Config } from "../types";
import { DailyDemand, demandClustersForRole } from "./demand-aggregation";
import { selectCompatibleShiftCodes, planForeignCompanyDay } from "../foreign-shift-planning";
import { getCompanyRequiredAgents, getCompanyTeamRoleConfig, TeamRoleConfig } from "../company-config";
import { GeneratedShiftAssignment, PriorDayShiftMap } from "./shift-generation";
import { getShiftTimesAs, getShiftDurationHours, LEGACY_BASELINE_DATE } from "../shift-templates";
import { flightDateFor } from "../flight-date";
import { isShiftExtensionPreferred } from "../teams";
import { computeEmployeeDayCountTopUp } from "./roster-generation";
import { FatigueConfig } from "../fatigue-config";
import { FatigueStateOrUnknown } from "./fatigue-model";
import { createFatigueLedger, advanceFatigueLedger, projectFatigueForShift, explainFatigueChoice, FatigueCandidateProjection } from "./fatigue-planning";
import { fatigueScoreSteps } from "./stage6-score-tiers";
import { HardWorkCaps, HardCapExclusion, HardCapExclusionReason, nextConsecutiveWorkDayStreak } from "./hard-work-caps";
import { CapAwareRosterTarget, computeCapAwareTargetWorkDays, preferredOffWindowLength } from "./roster-target";
import { HardCapRepair, HardCapRepairSearch, RepairSlotAssignment, RepairSlotGroup, repairSlotPopulationGaps } from "./hard-cap-repair";

/**
 * HARD WORK CAPS input for Profiling/Mesure and foreign-company generation
 * (2026-09-25, hard-constraints milestone phase 1 — see hard-work-caps.ts).
 * `incomingStreakByEmployee`: each employee's consecutive-work-day streak
 * entering the window (consecutive-days-continuity.ts's
 * incomingStreakForHardCap; missing = 0 — the caller discloses unknown
 * history). Both functions keep their own always-on running streak from it
 * and reuse their existing `usageHours` running totals for the hours side.
 * Omitted = no cap filtering (direct unit callers); generate-draft-plan.ts
 * always supplies it.
 */
export interface SpecializedHardCaps {
  caps: HardWorkCaps;
  incomingStreakByEmployee: ReadonlyMap<string, number>;
  exclusionsOut?: HardCapExclusion[];
  /** PART A (phase 2): receives each foreign-company member's cap-aware roster target (top-up population only). */
  targetsOut?: Map<string, CapAwareRosterTarget>;
  /** PART B (phase 2): receives every reallocation the bounded cross-employee repair pass applied. */
  repairsOut?: HardCapRepair[];
  /** PART B (phase 2): false disables the repair pass (tests compare with/without). Default true. */
  repair?: boolean;
}

/** Per-day cap state handed to assignPoolToWindow (the running values, read-only). */
interface PoolDayHardCaps {
  caps: HardWorkCaps;
  streakEnteringDay: ReadonlyMap<string, number>;
  hoursSoFar: ReadonlyMap<string, number>;
}

/** The streak map entering the next day: +1 for each pool member who worked today, 0 otherwise. */
function advanceStreaks(pool: Employee[], streaks: Map<string, number>, workedIds: ReadonlySet<string>): void {
  for (const e of pool) streaks.set(e.id, nextConsecutiveWorkDayStreak(streaks.get(e.id) ?? 0, workedIds.has(e.id)));
}

/**
 * FATIGUE-AWARE FOREIGN-COMPANY DISTRIBUTION (2026-09-24, fatigue
 * milestone part 2). Optional input to generateForeignCompanyShifts; inert
 * unless `config.enabled` is true (FATIGUE_MODEL_ENABLED stays false).
 * `incomingStates`: each employee's state entering the window
 * (fatigue-continuity.ts); a missing employee is an explicit unknown.
 */
export interface ForeignFatigueOptions {
  config: FatigueConfig;
  incomingStates?: ReadonlyMap<string, FatigueStateOrUnknown>;
}

/**
 * FAIRNESS FIX (2026-09-21): `assignPoolToWindow`/`assignPoolToWindowWithRoles`
 * always try their `pool` argument in the order it's given, taking the
 * first N that fit. When a team's real headcount need is smaller than the
 * team's size (the normal case — e.g. Air France: 3 needed, 5-person
 * team), calling both functions with the SAME static pool order every
 * single day meant the same first N employees were assigned EVERY day,
 * every week, while the rest of the team sat OFF permanently — not a
 * business-rule question, a genuine correctness bug that directly
 * contradicts ATLAS's core fairness goal (confirmed by RAM Handling,
 * Moses, 2026-09-21: "atlas should spread the work fairly around all the
 * agents he has").
 *
 * This sorts a team's pool by ascending CUMULATIVE assigned hours so far
 * THIS WINDOW (ties broken by stable original order, so behavior is still
 * fully deterministic) before every day's assignment call, and the caller
 * updates the running totals after each day. This is a fairness ORDERING
 * fix, not a policy magnitude to be left unconfirmed — it doesn't invent
 * any new headcount, weight, or business number; it only changes WHICH
 * already-eligible, already-interchangeable team members get picked
 * first, which is a correctness property this codebase's own stated goal
 * requires regardless of any confirmed/unconfirmed real-world number.
 * Applies uniformly to Profiling, Mesure, and every foreign-company team —
 * no per-team or per-airline special-casing.
 */
/** The calendar day before `date` ("YYYY-MM-DD"). */
function previousCalendarDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function sortByLeastUsedFirst(pool: Employee[], usageHours: Map<string, number>): Employee[] {
  return [...pool].sort((a, b) => (usageHours.get(a.id) ?? 0) - (usageHours.get(b.id) ?? 0));
}

/**
 * Generation-time roster derivation for the "middle" specialized
 * populations — Profiling, Mesure, and each foreign-company team — that
 * are neither fully fixed/cyclic (Transit, Leaders, Duty Officers; see
 * fixed-cycle-rotation.ts) nor general flexible RAM capacity (Stage 6,
 * shift-generation.ts, UNTOUCHED by this module). Both categories here
 * were previously baked into `Employee.weekly_shifts` once at seed time
 * (a single repeating shift code + a flat OFF-day count, or a per-
 * employee sequential walk that never compared against teammates) and
 * then simply re-read every week, unchanged, regardless of the actual
 * flight schedule or actual demand. That produced two real problems this
 * module fixes: (1) several of those static, single-code patterns cannot
 * satisfy the confirmed 15h minimum rest AT ALL (Duty Officers/Profiling/
 * Mesure's tight-rest subgroups — see the delivered audit), and (2) a
 * foreign company's roster never actually reacted to the CURRENT flight
 * schedule, so changing it and clicking Make Planning silently left these
 * teams' rosters stale.
 *
 * Both functions below instead derive each day's roster from data that
 * ALREADY exists in the plan being generated (the same weekly demand
 * aggregation Stage 6 itself uses for Profiling/Mesure; the same real
 * flight-window computation foreign-shift-planning.ts already provides
 * for foreign companies), and select a real catalog shift code (never an
 * invented one) via the SAME `selectCompatibleShiftCodes` ranking used
 * everywhere else a shift needs to cover an operational window — no new
 * shift-selection policy is introduced here, only a per-DAY, whole-GROUP
 * application of it (trying every member of the team, not just one
 * employee's own fixed sequential walk) with real cross-day rest
 * awareness against each employee's own actual previous day.
 *
 * When no compatible+rested employee exists to cover a day's need, this
 * is reported as a genuine DemandConflict (see below) — never a
 * rest-violating fallback shift. The caller (generate-draft-plan.ts)
 * turns this into a BLOCKING configuration issue, exactly like a
 * specialized team's own rotation being intrinsically rest-infeasible:
 * both are real workforce-design findings, not something this module
 * invents a shift-policy answer for.
 *
 * KNOWN LIMITATION, shared with shift-generation.ts (see
 * docs/known-limitations/roster-planning-vs-duty-allocation.md): whether
 * a Profiling/Mesure employee is rostered at all is decided purely by
 * that day's real demand, same as General T1 — the same future "roster
 * planning vs. duty allocation" redesign applies here too, once the
 * real working-hours obligation is confirmed.
 */

/** One day's genuine shortfall: this many fewer employees could be legally rostered than the real demand/commitment needed. */
export interface DemandConflict {
  team: string; // "Profiling" | "Mesure" | a foreign company name
  dayOfWeek: string;
  window: { start: string; end: string };
  needed: number;
  covered: number;
  /**
   * HARD WORK CAPS (2026-09-25, phase 1): team members who were rest-legal
   * with a compatible code for this window but were excluded by a hard cap
   * — present only when at least one such member existed, so a purely
   * rest/catalog-driven conflict is reported exactly as before.
   */
  capExcluded?: { employeeId: string; reason: HardCapExclusionReason }[];
  /**
   * HARD-CAP REPAIR (2026-09-25, phase 2): present only on a cap-involved
   * conflict that the bounded cross-employee repair pass
   * (hard-cap-repair.ts) searched and could not resolve — how many candidate
   * moves it evaluated and whether its budget ran out.
   */
  capRepair?: HardCapRepairSearch;
}

/**
 * Assigns as many of `pool` (in the given, deterministic order) to `need`
 * as both fit the window AND leave the confirmed minimum rest since that
 * specific employee's own previous real shift — never more than
 * `need.headcount`, never an employee already used elsewhere today (the
 * caller removes them from `pool` between calls if a team can have
 * multiple same-day windows). Returns exactly which code each selected
 * employee got (individually ranked, so two employees can legitimately
 * receive different compatible codes on the same day if their own rest
 * history differs) and any real shortfall.
 */
function assignPoolToWindow(
  pool: Employee[],
  window: { start: string; end: string },
  headcount: number,
  priorDayShift: PriorDayShiftMap,
  minimumRestHours: number,
  // See teams.ts's isShiftExtensionPreferred / foreign-shift-planning.ts's
  // preferExtended doc comments. Default false — every existing caller
  // unaffected, identical shift selection as before.
  preferExtended = false,
  // The real calendar date this window is being planned for — resolves
  // the shift regime effective on that day (see lib/shift-templates.ts).
  date: string = LEGACY_BASELINE_DATE,
  // HARD WORK CAPS (2026-09-25, phase 1) — passed straight into
  // selectCompatibleShiftCodes' filter step (same gate as the rest check).
  hardCaps?: PoolDayHardCaps
): { assigned: { employeeId: string; shiftCode: string }[]; shortfall: number; capExcluded: { employeeId: string; reason: HardCapExclusionReason }[] } {
  const assigned: { employeeId: string; shiftCode: string }[] = [];
  const capExcluded: { employeeId: string; reason: HardCapExclusionReason }[] = [];
  for (const employee of pool) {
    if (assigned.length >= headcount) break;
    const prior = priorDayShift.get(employee.id) ?? null;
    // allowLateStart: true — see selectCompatibleShiftCodes' doc comment.
    // This window is a Profiling/Mesure demand cluster's full span, not a
    // foreign company's dedicated protected commitment, so the same
    // reasoning as shift-generation.ts's General T1 loop applies: a
    // late-starting-but-otherwise-covering shift is real, usable coverage,
    // not a bug.
    const candidates = selectCompatibleShiftCodes(
      window.start,
      window.end,
      prior?.shift_start ?? null,
      prior?.shift_end ?? null,
      minimumRestHours,
      true,
      preferExtended,
      date,
      hardCaps
        ? {
            consecutiveWorkDaysBeforeToday: hardCaps.streakEnteringDay.get(employee.id) ?? 0,
            maxConsecutiveWorkDays: hardCaps.caps.maxConsecutiveWorkDays,
            hoursSoFarThisWeek: hardCaps.hoursSoFar.get(employee.id) ?? 0,
            hardWeeklyHoursCap: hardCaps.caps.hardWeeklyHoursCap,
          }
        : undefined
    );
    if (candidates.length > 0) {
      assigned.push({ employeeId: employee.id, shiftCode: candidates[0].code });
    } else if (hardCaps) {
      // Transparency only (the decision is already made above): was this
      // member rest-legal with a compatible code, i.e. excluded by a cap?
      const restOnly = selectCompatibleShiftCodes(window.start, window.end, prior?.shift_start ?? null, prior?.shift_end ?? null, minimumRestHours, true, preferExtended, date);
      if (restOnly.length > 0) {
        const streak = hardCaps.streakEnteringDay.get(employee.id) ?? 0;
        capExcluded.push({ employeeId: employee.id, reason: streak + 1 > hardCaps.caps.maxConsecutiveWorkDays ? "consecutive_work_days" : "hard_weekly_hours" });
      }
    }
  }
  return { assigned, shortfall: Math.max(0, headcount - assigned.length), capExcluded };
}

/**
 * TEAM COMPOSITION (see company-config.ts's TeamRoleConfig doc comment):
 * splits a pool into its ACE and Leader sub-populations for a team with a
 * CONFIRMED role split. When no split is confirmed for this team
 * (`roleConfig === null` — every team today except Gulf Air), everyone is
 * treated as one interchangeable pool, in the `aces` bucket, exactly the
 * pre-existing behavior — `leaders` is empty and never consulted.
 */
function partitionPoolByRole(pool: Employee[], roleConfig: TeamRoleConfig | null): { aces: Employee[]; leaders: Employee[] } {
  if (!roleConfig) return { aces: pool, leaders: [] };
  return {
    aces: pool.filter((e) => e.team_role !== "leader"),
    leaders: pool.filter((e) => e.team_role === "leader"),
  };
}

/**
 * Assigns a pool to a window, respecting a confirmed team-role split when
 * one exists: ACE slots are filled ONLY from non-leader members (up to
 * `roleConfig.aceCount`), Leader slots ONLY from leader members (up to
 * `roleConfig.leaderCount`) — a Leader never silently fills an ACE slot,
 * and vice versa, even if the other sub-pool runs short (that shows up as
 * a genuine, honestly-reported shortfall instead). When `roleConfig` is
 * null, this is byte-for-byte the original single-pool assignPoolToWindow
 * call with the full headcount — no behavior change for any team without
 * a confirmed split.
 */
function assignPoolToWindowWithRoles(
  pool: Employee[],
  window: { start: string; end: string },
  headcount: number,
  roleConfig: TeamRoleConfig | null,
  priorDayShift: PriorDayShiftMap,
  minimumRestHours: number,
  preferExtended = false,
  date: string = LEGACY_BASELINE_DATE,
  hardCaps?: PoolDayHardCaps
): { assigned: { employeeId: string; shiftCode: string }[]; shortfall: number; capExcluded: { employeeId: string; reason: HardCapExclusionReason }[] } {
  if (!roleConfig) {
    return assignPoolToWindow(pool, window, headcount, priorDayShift, minimumRestHours, preferExtended, date, hardCaps);
  }
  const { aces, leaders } = partitionPoolByRole(pool, roleConfig);
  const aceResult = assignPoolToWindow(aces, window, roleConfig.aceCount, priorDayShift, minimumRestHours, preferExtended, date, hardCaps);
  const leaderResult = assignPoolToWindow(leaders, window, roleConfig.leaderCount, priorDayShift, minimumRestHours, preferExtended, date, hardCaps);
  return {
    assigned: [...aceResult.assigned, ...leaderResult.assigned],
    shortfall: aceResult.shortfall + leaderResult.shortfall,
    capExcluded: [...aceResult.capExcluded, ...leaderResult.capExcluded],
  };
}

/**
 * HARD-CAP REPAIR bookkeeping (phase 2): the greedy's conflicts, re-derived
 * against the repaired assignments. A group now fully covered drops its
 * conflict; a still-short one keeps its original shape with `covered`
 * updated, `capExcluded` narrowed to members still not working that day,
 * and `capRepair` recording that the bounded repair search ran (so the
 * BLOCKING wording can say so). Conflicts without cap involvement are left
 * byte-for-byte as they were.
 */
function recomputeSlotConflicts(
  original: { conflict: DemandConflict; groupKey: string | string[] }[],
  assignmentsByDay: Record<string, RepairSlotAssignment[]>,
  search: HardCapRepairSearch
): DemandConflict[] {
  const out: DemandConflict[] = [];
  for (const { conflict, groupKey } of original) {
    const keys = Array.isArray(groupKey) ? groupKey : [groupKey];
    const day = assignmentsByDay[conflict.dayOfWeek] ?? [];
    const covered = day.filter((a) => keys.includes(a.groupKey)).length;
    if (covered >= conflict.needed) continue;
    if (!conflict.capExcluded) {
      out.push(conflict);
      continue;
    }
    const working = new Set(day.map((a) => a.employeeId));
    const capExcluded = conflict.capExcluded.filter((x) => !working.has(x.employeeId));
    const { capExcluded: _drop, ...rest } = conflict;
    void _drop;
    out.push({ ...rest, covered, ...(capExcluded.length > 0 ? { capExcluded } : {}), capRepair: search });
  }
  return out;
}

/** The explanation of the repair that placed `employeeId` on `day` for `team`, if any. */
function repairReasonFor(repairs: readonly HardCapRepair[] | undefined, team: string, employeeId: string, day: string): string | undefined {
  if (!repairs) return undefined;
  for (const r of repairs) {
    if (r.team !== team) continue;
    if ((r.toEmployeeId === employeeId && r.reassignedDay === day) || (r.filledByEmployeeId === employeeId && r.targetDay === day && r.kind !== "reallocate_for_off_run")) return r.explanation;
  }
  return undefined;
}

/**
 * Profiling and Mesure: demand comes from the SAME weekly demand
 * aggregation Stage 6 already computes for the whole week
 * (aggregateDailyDemand, called once in generate-draft-plan.ts) — this
 * function only reads it, via demandClustersForRole, exactly as a future
 * Stage-6-style consumer would. A day with no Profiling/Mesure demand at
 * all means the whole team is OFF that day — no fabricated same-code
 * "just in case" work, matching the same principle already established
 * for the flexible pool.
 */
export function generateProfilingMesureShifts(
  daysOrder: string[],
  employees: Employee[],
  demandByDay: Record<string, DailyDemand>,
  minimumRestHours: number,
  // The real Monday date this daysOrder window starts on — resolves the
  // shift regime effective on each real calendar day (see
  // lib/shift-templates.ts).
  weekStart: string,
  priorWeekBoundaryContext: PriorDayShiftMap = new Map(),
  // HARD WORK CAPS (2026-09-25, phase 1) — see SpecializedHardCaps.
  hardCaps?: SpecializedHardCaps
): { generatedShiftsByDay: Record<string, GeneratedShiftAssignment[]>; conflicts: DemandConflict[] } {
  const generatedShiftsByDay: Record<string, GeneratedShiftAssignment[]> = {};
  const conflicts: DemandConflict[] = [];

  for (const team of ["Profiling", "Mesure"]) {
    const pool = employees.filter((e) => e.active && e.assignment === team);
    const preferExtended = isShiftExtensionPreferred(team);
    let priorDayShift: PriorDayShiftMap = new Map(priorWeekBoundaryContext);
    // See sortByLeastUsedFirst's doc comment: spreads work across the
    // whole team instead of always favoring the same first N in `pool`.
    const usageHours = new Map<string, number>(pool.map((e) => [e.id, 0]));
    // Always-on consecutive-work-day streak (hard-work-caps.ts), advanced
    // once per day right alongside priorDayShift/usageHours below.
    const streaks = new Map<string, number>(pool.map((e) => [e.id, hardCaps?.incomingStreakByEmployee.get(e.id) ?? 0]));
    const dayCaps: PoolDayHardCaps | undefined = hardCaps ? { caps: hardCaps.caps, streakEnteringDay: streaks, hoursSoFar: usageHours } : undefined;
    // Team-local results, merged into generatedShiftsByDay/conflicts once the
    // (optional) hard-cap repair pass below has run. Same order as before.
    const teamAssignmentsByDay: Record<string, RepairSlotAssignment[]> = {};
    const teamGroupsByDay: Record<string, RepairSlotGroup[]> = {};
    const teamConflicts: { conflict: DemandConflict; groupKey: string }[] = [];
    let teamCapExclusionSeen = false;
    const poolIds = new Set(pool.map((e) => e.id));

    for (const day of daysOrder) {
      const date = flightDateFor(weekStart, day);
      const clusters = demandClustersForRole(demandByDay[day], team);
      const dayAssignments: RepairSlotAssignment[] = [];
      let remainingPool = sortByLeastUsedFirst(pool, usageHours);
      teamGroupsByDay[day] = [];

      clusters.forEach((cluster, clusterIndex) => {
        const groupKey = `${team}-${day}-${clusterIndex}`;
        teamGroupsByDay[day].push({ key: groupKey, window: { start: cluster.start, end: cluster.end }, needed: cluster.peak, eligibleIds: poolIds });
        const { assigned, shortfall, capExcluded } = assignPoolToWindow(remainingPool, cluster, cluster.peak, priorDayShift, minimumRestHours, preferExtended, date, dayCaps);
        dayAssignments.push(...assigned.map((a) => ({ ...a, groupKey })));
        const assignedIds = new Set(assigned.map((a) => a.employeeId));
        remainingPool = remainingPool.filter((e) => !assignedIds.has(e.id));
        for (const x of capExcluded) hardCaps?.exclusionsOut?.push({ employeeId: x.employeeId, dayOfWeek: day, population: "profiling_mesure", reason: x.reason });
        if (capExcluded.length > 0) teamCapExclusionSeen = true;
        if (shortfall > 0) {
          teamConflicts.push({
            groupKey,
            conflict: {
              team,
              dayOfWeek: day,
              window: { start: cluster.start, end: cluster.end },
              needed: cluster.peak,
              covered: cluster.peak - shortfall,
              ...(capExcluded.length > 0 ? { capExcluded } : {}),
            },
          });
        }
      });

      teamAssignmentsByDay[day] = dayAssignments;
      for (const a of dayAssignments) {
        usageHours.set(a.employeeId, (usageHours.get(a.employeeId) ?? 0) + getShiftDurationHours(a.shiftCode, date));
      }

      const nextPriorDayShift: PriorDayShiftMap = new Map();
      for (const employee of pool) {
        const a = dayAssignments.find((x) => x.employeeId === employee.id);
        nextPriorDayShift.set(employee.id, a ? getShiftTimesAs(a.shiftCode, date) : null);
      }
      priorDayShift = nextPriorDayShift;
      advanceStreaks(pool, streaks, new Set(dayAssignments.map((a) => a.employeeId)));
    }

    // HARD-CAP REPAIR (2026-09-25, phase 2 part B — hard-cap-repair.ts): only
    // when a hard cap excluded someone in this team AND a real shortfall
    // remains. Otherwise nothing below runs and the output is byte-identical.
    let finalAssignmentsByDay = teamAssignmentsByDay;
    let finalConflicts = teamConflicts.map((c) => c.conflict);
    let teamRepairs: HardCapRepair[] = [];
    if (hardCaps && hardCaps.repair !== false && teamCapExclusionSeen && teamConflicts.length > 0) {
      const result = repairSlotPopulationGaps({
        population: "profiling_mesure",
        team,
        ctx: { daysOrder, weekStart, minimumRestHours, caps: hardCaps.caps, incomingStreakByEmployee: hardCaps.incomingStreakByEmployee, priorWeekBoundaryContext },
        preferExtended,
        poolIds: pool.map((e) => e.id),
        names: new Map(pool.map((e) => [e.id, e.name])),
        groupsByDay: teamGroupsByDay,
        assignmentsByDay: teamAssignmentsByDay,
      });
      teamRepairs = result.repairs;
      hardCaps.repairsOut?.push(...result.repairs);
      finalAssignmentsByDay = result.assignmentsByDay;
      finalConflicts = recomputeSlotConflicts(teamConflicts, finalAssignmentsByDay, result.search);
    }

    for (const day of daysOrder) {
      if (!generatedShiftsByDay[day]) generatedShiftsByDay[day] = [];
      for (const a of finalAssignmentsByDay[day] ?? []) {
        const g: GeneratedShiftAssignment = { employeeId: a.employeeId, dayOfWeek: day, shiftCode: a.shiftCode, coversRoles: [team] };
        const reason = repairReasonFor(teamRepairs, team, a.employeeId, day);
        if (reason) g.hardCapRepairReason = reason;
        generatedShiftsByDay[day].push(g);
      }
    }
    conflicts.push(...finalConflicts);
  }

  return { generatedShiftsByDay, conflicts };
}

/**
 * Foreign-company teams: roster driven primarily by the company's real
 * flight days/windows (findCompanyFlightsOnDay/planForeignCompanyDay,
 * foreign-shift-planning.ts — unchanged, reused as-is). Unlike the
 * previous per-employee sequential walk (applyForeignCompanyRoster,
 * seed-data.ts — now only a durable/legacy baseline, no longer
 * authoritative for planning; see generate-draft-plan.ts), this tries
 * EVERY member of the company's own group for a flight day before
 * accepting a shortfall, and never falls back to a rest-ignoring shift:
 * if nobody in the group can legally cover a flight day, that is reported
 * as a genuine DemandConflict, not silently persisted.
 *
 * Headcount per flight day is the confirmed per-company figure already
 * used elsewhere for this exact purpose (getCompanyRequiredAgents,
 * company-config.ts — the same number the Rotation Feasibility Engine
 * already treats as this company's real weekly demand), not a new one
 * invented here.
 *
 * NORMAL RAM ROSTER TOP-UP (2026-09-22 — see
 * docs/known-limitations/roster-planning-vs-duty-allocation.md): a day
 * with no company flight at all, or where an employee wasn't one of the
 * N selected for that day's real flight, no longer leaves that employee
 * with no roster entry at all (which reads as OFF downstream). Foreign-
 * company ACEs remain RAM Handling employees and are entitled to the SAME
 * "5 WORK + 2 OFF, independent of demand" normal roster target the
 * flexible General T1 pool already gets — see
 * roster-generation.ts's `computeEmployeeDayCountTopUp`, reused here
 * UNCHANGED rather than reimplemented, so the two populations' soft
 * consecutive-OFF preference never drifts apart. A day this top-up adds is
 * a real, honest RAM-compatible working day (their own base/default shift
 * template via the shortest-legal-catalog-code rule, exactly as the
 * flexible pool's own top-up picks) — never a fabricated company duty.
 * The employee stays a distinct population throughout (never folded into
 * `isFlexibleGeneralPool` — see workforce-pools.ts's own doc comment on
 * why not): on a real flight day they're still anchored to the protected-
 * window-covering shift above; this top-up only ever fills a day company
 * demand left completely untouched.
 *
 * FATIGUE (2026-09-24, fatigue milestone part 2): with an ENABLED
 * `fatigue` option, each flight day's team pool is ordered by the
 * resulting fatigue burden of taking that day's commitment (lowest first;
 * least-used hours second; original order third) before the unchanged
 * assignPoolToWindowWithRoles walk — so a difficult (e.g. very early)
 * commitment is distributed to the eligible, rest-legal member with the
 * lowest recent burden. Required foreign-company coverage ALWAYS wins:
 * the walk still tries every member until the confirmed headcount is met,
 * so the reordering can never cause a shortfall and never delays or blocks
 * an assignment. The team's top-up days get the same lower-burden code
 * ordering as the flexible pool's (TopUpFatigueOptions).
 */
export function generateForeignCompanyShifts(
  daysOrder: string[],
  employees: Employee[],
  flights: Flight[],
  configuredCompanies: string[],
  minimumRestHours: number,
  // The real Monday date this daysOrder window starts on — resolves the
  // shift regime effective on each real calendar day (see
  // lib/shift-templates.ts).
  weekStart: string,
  priorWeekBoundaryContext: PriorDayShiftMap = new Map(),
  // Optional: when provided, the normal-RAM-roster top-up (see this
  // function's doc comment) runs on top of the flight-driven result
  // above. Defaults to undefined so every existing caller/test that only
  // cares about the flight-driven roster keeps working byte-for-byte
  // unchanged (the top-up is a strict, additive no-op without a config to
  // read `normal_weekly_off_days` from).
  config?: Pick<Config, "normal_weekly_off_days"> & Partial<Pick<Config, "max_consecutive_off_days">>,
  // FATIGUE-AWARE DISTRIBUTION (2026-09-24, part 2) — see
  // ForeignFatigueOptions and the "FATIGUE" paragraph of this function's
  // doc comment. Optional; omitted or disabled = exact prior behaviour.
  fatigue?: ForeignFatigueOptions,
  // HARD WORK CAPS (2026-09-25, phase 1) — see SpecializedHardCaps. Applied
  // to flight days (selectCompatibleShiftCodes' filter) AND to the normal
  // RAM roster top-up (computeEmployeeDayCountTopUp's legalCodesAt).
  hardCaps?: SpecializedHardCaps
): { generatedShiftsByDay: Record<string, GeneratedShiftAssignment[]>; conflicts: DemandConflict[] } {
  const generatedShiftsByDay: Record<string, GeneratedShiftAssignment[]> = {};
  const conflicts: DemandConflict[] = [];
  const fatigueActive = fatigue?.config.enabled === true;

  for (const company of configuredCompanies) {
    const pool = employees.filter((e) => e.active && e.assignment === company);
    if (pool.length === 0) continue;
    const headcount = getCompanyRequiredAgents(company);
    const roleConfig = getCompanyTeamRoleConfig(company);
    const preferExtended = isShiftExtensionPreferred(company);
    let priorDayShift: PriorDayShiftMap = new Map(priorWeekBoundaryContext);
    // See sortByLeastUsedFirst's doc comment: spreads work across the
    // whole company team instead of always favoring the same first N in
    // `pool` (the bug that left Tarik Idrissi/Widad Idrissi permanently
    // OFF while Fadwa/Khalid/Marouane Idrissi took every Air France duty).
    const usageHours = new Map<string, number>(pool.map((e) => [e.id, 0]));
    // Always-on consecutive-work-day streak (hard-work-caps.ts), advanced
    // once per day right alongside priorDayShift/usageHours below.
    const streaks = new Map<string, number>(pool.map((e) => [e.id, hardCaps?.incomingStreakByEmployee.get(e.id) ?? 0]));
    const dayCaps: PoolDayHardCaps | undefined = hardCaps ? { caps: hardCaps.caps, streakEnteringDay: streaks, hoursSoFar: usageHours } : undefined;
    // Running fatigue state for this company's team (see fatigue-planning.ts's
    // FatigueLedger), advanced once per day. Only when fatigue is enabled.
    const ledger = fatigueActive
      ? createFatigueLedger(
          pool.map((e) => e.id),
          fatigue!.config,
          fatigue!.incomingStates,
          priorWeekBoundaryContext,
          previousCalendarDate(flightDateFor(weekStart, daysOrder[0]))
        )
      : null;
    // HARD-CAP REPAIR bookkeeping (phase 2): this company's needs per day as
    // slot groups (one group, or ACE + Leader groups for a confirmed role
    // split), its conflicts, and whether any hard-cap exclusion happened.
    const companyGroupsByDay: Record<string, RepairSlotGroup[]> = {};
    const companyConflicts: { conflict: DemandConflict; groupKey: string[] }[] = [];
    let companyCapExclusionSeen = false;
    const { aces: aceMembers, leaders: leaderMembers } = partitionPoolByRole(pool, roleConfig);
    const aceIds = new Set(aceMembers.map((e) => e.id));
    const leaderIds = new Set(leaderMembers.map((e) => e.id));
    const groupKeyFor = (day: string, employeeId: string) => (roleConfig ? `${company}-${day}-${leaderIds.has(employeeId) ? "leader" : "ace"}` : `${company}-${day}`);

    for (const day of daysOrder) {
      const date = flightDateFor(weekStart, day);
      const plan = planForeignCompanyDay(company, day, flights, undefined, undefined, undefined, date);
      companyGroupsByDay[day] = [];
      if (plan && headcount !== undefined) {
        companyGroupsByDay[day] = roleConfig
          ? [
              { key: `${company}-${day}-ace`, window: plan.combinedWindow, needed: roleConfig.aceCount, eligibleIds: aceIds },
              { key: `${company}-${day}-leader`, window: plan.combinedWindow, needed: roleConfig.leaderCount, eligibleIds: leaderIds },
            ]
          : [{ key: `${company}-${day}`, window: plan.combinedWindow, needed: headcount, eligibleIds: new Set(pool.map((e) => e.id)) }];
      }
      let dayAssignments: { employeeId: string; shiftCode: string }[] = [];
      const fatigueReasons = new Map<string, string[]>();

      if (plan && headcount !== undefined) {
        // FATIGUE: when enabled, the pool is ordered by the RESULTING burden
        // of taking today's commitment (state entering today + the
        // commitment's covering code on today's real date + transition),
        // quantized like Stage 6's tier 4, with least-used hours as the
        // secondary key. This is ONLY an ordering of the same pool:
        // assignPoolToWindowWithRoles still walks EVERY member until the
        // headcount is met, so whether the protected window is covered is
        // unchanged — fatigue can never cause, or hide, a shortfall.
        let orderedPool = sortByLeastUsedFirst(pool, usageHours);
        const projections = new Map<string, FatigueCandidateProjection>();
        if (ledger && plan.shiftCode) {
          for (const e of pool) {
            projections.set(e.id, projectFatigueForShift(e.id, ledger.states.get(e.id)!, ledger.lastWorked.get(e.id), plan.shiftCode, date, ledger.config));
          }
          const steps = (id: string) => fatigueScoreSteps(projections.get(id)!.after.accumulatedBurden);
          orderedPool = orderedPool
            .map((e, k) => ({ e, k, s: steps(e.id) }))
            .sort((a, b) => a.s - b.s || a.k - b.k)
            .map((x) => x.e);
        }
        const { assigned, shortfall, capExcluded } = assignPoolToWindowWithRoles(
          orderedPool,
          plan.combinedWindow,
          headcount,
          roleConfig,
          priorDayShift,
          minimumRestHours,
          preferExtended,
          date,
          dayCaps
        );
        dayAssignments = assigned;
        for (const x of capExcluded) hardCaps?.exclusionsOut?.push({ employeeId: x.employeeId, dayOfWeek: day, population: "foreign_company", reason: x.reason });
        if (capExcluded.length > 0) companyCapExclusionSeen = true;
        if (shortfall > 0) {
          companyConflicts.push({
            groupKey: companyGroupsByDay[day].map((g) => g.key),
            conflict: {
              team: company,
              dayOfWeek: day,
              window: plan.combinedWindow,
              needed: headcount,
              covered: headcount - shortfall,
              ...(capExcluded.length > 0 ? { capExcluded } : {}),
            },
          });
        }
        if (ledger && plan.shiftCode) {
          // Explainability: re-run the SAME (pure) walk with the pre-fatigue
          // order to see whom fatigue displaced. Each member fatigue brought
          // in is explained against a displaced member (in order); a member
          // selected either way gets [] (fatigue did not change that pick).
          const withoutFatigue = assignPoolToWindowWithRoles(
            sortByLeastUsedFirst(pool, usageHours), plan.combinedWindow, headcount, roleConfig, priorDayShift, minimumRestHours, preferExtended, date, dayCaps
          ).assigned.map((a) => a.employeeId);
          const selectedIds = new Set(assigned.map((a) => a.employeeId));
          const displaced = withoutFatigue.filter((id) => !selectedIds.has(id));
          for (const a of assigned) {
            if (withoutFatigue.includes(a.employeeId)) {
              fatigueReasons.set(a.employeeId, []);
              continue;
            }
            const other = displaced.shift();
            fatigueReasons.set(a.employeeId, other ? explainFatigueChoice(projections.get(a.employeeId)!, projections.get(other)!, ledger.config) : []);
          }
        }
      }
      // No flight today (plan === null), or no confirmed headcount for
      // this company (shouldn't happen for a CONFIGURED company, but
      // never invent one if it did) -- the group's real flight-driven
      // outcome is genuinely empty here; the normal-RAM-roster top-up
      // below (when `config` is provided) is what turns that into an
      // honest working day for whoever still needs one this week, rather
      // than a fabricated company duty.

      if (!generatedShiftsByDay[day]) generatedShiftsByDay[day] = [];
      for (const a of dayAssignments) {
        const g: GeneratedShiftAssignment = { employeeId: a.employeeId, dayOfWeek: day, shiftCode: a.shiftCode, coversRoles: [company] };
        if (ledger) g.fatigueReason = fatigueReasons.get(a.employeeId) ?? [];
        generatedShiftsByDay[day].push(g);
        usageHours.set(a.employeeId, (usageHours.get(a.employeeId) ?? 0) + getShiftDurationHours(a.shiftCode, date));
      }
      if (ledger) advanceFatigueLedger(ledger, date, new Map(dayAssignments.map((a) => [a.employeeId, a.shiftCode])));

      const nextPriorDayShift: PriorDayShiftMap = new Map();
      for (const employee of pool) {
        const a = dayAssignments.find((x) => x.employeeId === employee.id);
        nextPriorDayShift.set(employee.id, a ? getShiftTimesAs(a.shiftCode, date) : null);
      }
      priorDayShift = nextPriorDayShift;
      advanceStreaks(pool, streaks, new Set(dayAssignments.map((a) => a.employeeId)));
    }

    // HARD-CAP REPAIR (2026-09-25, phase 2 part B — hard-cap-repair.ts): on
    // the flight-day roster, BEFORE the roster top-up, only when a hard cap
    // excluded a member of this company AND a flight day is still short.
    // Otherwise nothing here runs and the output is byte-identical.
    if (hardCaps && hardCaps.repair !== false && companyCapExclusionSeen && companyConflicts.length > 0) {
      const poolIdSet = new Set(pool.map((e) => e.id));
      const assignmentsByDay: Record<string, RepairSlotAssignment[]> = {};
      for (const day of daysOrder) {
        assignmentsByDay[day] = (generatedShiftsByDay[day] ?? []).filter((g) => poolIdSet.has(g.employeeId)).map((g) => ({ employeeId: g.employeeId, shiftCode: g.shiftCode, groupKey: groupKeyFor(day, g.employeeId) }));
      }
      const result = repairSlotPopulationGaps({
        population: "foreign_company",
        team: company,
        ctx: { daysOrder, weekStart, minimumRestHours, caps: hardCaps.caps, incomingStreakByEmployee: hardCaps.incomingStreakByEmployee, priorWeekBoundaryContext },
        preferExtended,
        poolIds: pool.map((e) => e.id),
        names: new Map(pool.map((e) => [e.id, e.name])),
        groupsByDay: companyGroupsByDay,
        assignmentsByDay,
      });
      hardCaps.repairsOut?.push(...result.repairs);
      if (result.assignmentsByDay !== assignmentsByDay) {
        for (const day of daysOrder) {
          const kept = (generatedShiftsByDay[day] ?? []).filter((g) => !poolIdSet.has(g.employeeId));
          const originals = new Map((generatedShiftsByDay[day] ?? []).filter((g) => poolIdSet.has(g.employeeId)).map((g) => [g.employeeId, g]));
          generatedShiftsByDay[day] = [
            ...kept,
            ...result.assignmentsByDay[day].map((a) => {
              const original = originals.get(a.employeeId);
              if (original && original.shiftCode === a.shiftCode) return original;
              const g: GeneratedShiftAssignment = { employeeId: a.employeeId, dayOfWeek: day, shiftCode: a.shiftCode, coversRoles: [company] };
              if (ledger) g.fatigueReason = [];
              const reason = repairReasonFor(result.repairs, company, a.employeeId, day);
              if (reason) g.hardCapRepairReason = reason;
              return g;
            }),
          ];
        }
        // The top-up below reads each member's real flight-day hours.
        for (const e of pool) usageHours.set(e.id, 0);
        for (const day of daysOrder) {
          for (const g of generatedShiftsByDay[day]) {
            if (poolIdSet.has(g.employeeId)) usageHours.set(g.employeeId, (usageHours.get(g.employeeId) ?? 0) + getShiftDurationHours(g.shiftCode, flightDateFor(weekStart, day)));
          }
        }
      }
      conflicts.push(...recomputeSlotConflicts(companyConflicts, result.assignmentsByDay, result.search));
    } else {
      conflicts.push(...companyConflicts.map((c) => c.conflict));
    }

    // NORMAL RAM ROSTER TOP-UP — see this function's doc comment. Runs
    // once per company, per employee, over the whole window, exactly the
    // same shape as roster-generation.ts's own flexible-pool loop: reach
    // "5 WORK + 2 OFF" (`daysOrder.length - config.normal_weekly_off_days`
    // worked days), never chasing a still-unconfirmed hours target
    // (`targetHoursThisWindow` is always null here — objective 2 stays
    // gated exactly as it does for the flexible pool), with the same
    // consecutive-OFF soft preference and forward rest lookahead against
    // whatever real company-flight-day shift already exists.
    if (config) {
      const normalTargetWorkDays = Math.max(0, daysOrder.length - config.normal_weekly_off_days);
      for (const employee of pool) {
        const scheduledDays = new Set<string>(
          daysOrder.filter((d) => (generatedShiftsByDay[d] ?? []).some((g) => g.employeeId === employee.id))
        );
        // PART A (2026-09-25, hard-constraints phase 2): with hard caps, the
        // target is this member's own CAP-AWARE target (roster-target.ts) from
        // their real flight-day hours plus the real shortest code per free
        // day — the same rule as the flexible pool's top-up. Without hard
        // caps, the fixed normal target, byte-for-byte as before.
        let targetWorkingDaysThisWindow = normalTargetWorkDays;
        let offWindowLength = config.normal_weekly_off_days;
        if (hardCaps) {
          const committedHoursByDay = new Map<string, number>();
          for (const d of daysOrder) {
            const g = (generatedShiftsByDay[d] ?? []).find((x) => x.employeeId === employee.id);
            if (g) committedHoursByDay.set(d, getShiftDurationHours(g.shiftCode, flightDateFor(weekStart, d)));
          }
          const target = computeCapAwareTargetWorkDays({ daysOrder, weekStart, normalTargetWorkDays, hardWeeklyHoursCap: hardCaps.caps.hardWeeklyHoursCap, committedHoursByDay });
          hardCaps.targetsOut?.set(employee.id, target);
          targetWorkingDaysThisWindow = target.targetWorkDays;
          offWindowLength = preferredOffWindowLength(daysOrder.length, targetWorkingDaysThisWindow, config.normal_weekly_off_days, config.max_consecutive_off_days ?? config.normal_weekly_off_days);
        }
        const getExistingShift = (d: string) => (generatedShiftsByDay[d] ?? []).find((x) => x.employeeId === employee.id);
        const topUpReasons = fatigueActive ? new Map<string, string[]>() : undefined;
        const capShortfall: { day: string; reason: HardCapExclusionReason }[] = [];

        const additions = computeEmployeeDayCountTopUp(
          employee.id,
          daysOrder,
          weekStart,
          scheduledDays,
          // The employee's REAL flight-day hours so far (usageHours — the same
          // running total the fairness ordering uses). Only read by the hard
          // weekly-hours cap: the hours OBJECTIVE is never chased here
          // (targetHoursThisWindow below is always null, so this value never
          // creates an hours shortfall) — see doc comment. Was a literal 0
          // before the hard caps existed, which is equivalent for that
          // objective.
          hardCaps ? usageHours.get(employee.id) ?? 0 : 0,
          getExistingShift,
          priorWeekBoundaryContext,
          minimumRestHours,
          targetWorkingDaysThisWindow,
          offWindowLength,
          null, // targetHoursThisWindow — always unconfirmed/gated for this population, same as the flexible pool default
          undefined,
          undefined,
          topUpReasons ? { config: fatigue!.config, reasonsOut: topUpReasons } : undefined,
          hardCaps
            ? { caps: hardCaps.caps, incomingStreak: hardCaps.incomingStreakByEmployee.get(employee.id) ?? 0, shortfallOut: capShortfall, maxConsecutiveOffDays: config.max_consecutive_off_days }
            : undefined
        );
        for (const { day, reason } of capShortfall) {
          hardCaps?.exclusionsOut?.push({ employeeId: employee.id, dayOfWeek: day, population: "foreign_company_top_up", reason });
        }

        for (const [day, shiftCode] of additions) {
          if (!generatedShiftsByDay[day]) generatedShiftsByDay[day] = [];
          const g: GeneratedShiftAssignment = { employeeId: employee.id, dayOfWeek: day, shiftCode, coversRoles: [] };
          if (topUpReasons) g.fatigueReason = topUpReasons.get(day) ?? [];
          generatedShiftsByDay[day].push(g);
        }
      }
    }
  }

  return { generatedShiftsByDay, conflicts };
}
