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
import { HardCapRepair, HardCapRepairSearch, RepairSlotAssignment, RepairSlotGroup, repairSlotPopulationGaps } from "./hard-cap-repair";
import { CapPacedRestPlan, allocateProportionally, planAllowsDrawIn, planCapPacedRestDays } from "./cap-paced-rest";
import { planDemandAwareOffWindows } from "./off-window";

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
  /** PART B (phase 2): receives every reallocation the bounded cross-employee repair pass applied. */
  repairsOut?: HardCapRepair[];
  /** PART B (phase 2): false disables the repair pass (tests compare with/without). Default true. */
  repair?: boolean;
  /**
   * CAP-PACED REST PLANNING (2026-09-25 lockstep fix — cap-paced-rest.ts):
   * false disables it (tests compare before/after). Default true. Inert —
   * byte-identical output — for any team whose estimated capacity under the
   * hard caps covers the week's demand.
   */
  capPacing?: boolean;
  /** Soft shaping for the cap-paced rest planner (Config.max_consecutive_off_days). Omitted = no shaping. */
  maxConsecutiveOffDays?: number;
}

/** Per-day cap state handed to assignPoolToWindow (the running values, read-only). */
interface PoolDayHardCaps {
  caps: HardWorkCaps;
  streakEnteringDay: ReadonlyMap<string, number>;
}

/** The streak map entering the next day: +1 for each pool member who worked today, 0 otherwise. */
function advanceStreaks(pool: Employee[], streaks: Map<string, number>, workedIds: ReadonlySet<string>): void {
  for (const e of pool) streaks.set(e.id, nextConsecutiveWorkDayStreak(streaks.get(e.id) ?? 0, workedIds.has(e.id)));
}

/**
 * OFF/OFF PHASE 2 (2026-09-29) — the weekly OFF-day HARD rules for the
 * specialized generation-driven populations (Profiling, Mesure, foreign
 * companies), resolved from Config by the caller (generate-draft-plan.ts):
 *   - minimumOffDaysPerWeek: Config.minimum_off_days_per_planning_week (hard floor);
 *   - normalWeeklyOffDays:   Config.normal_weekly_off_days (preferred target when demand allows);
 *   - consecutive:           Config.normal_off_days_consecutive (one cyclic block).
 * `priorDayOffEmployeeIds`: members KNOWN (real persisted predecessor plan
 * only) to have been OFF the day before daysOrder[0] — the same guard
 * planPreferredOffWindows applies to the flexible pool (a window containing
 * daysOrder[0] would extend that real OFF run across the boundary).
 * `windowsOut` receives every member's planned OFF window (day labels), for
 * transparency and for callers/tests that need the plan itself.
 *
 * Omitted (direct unit callers) = no OFF-day planning at all — the exact
 * pre-phase-2 behaviour, byte-for-byte.
 */
export interface SpecializedOffDayRules {
  minimumOffDaysPerWeek: number;
  normalWeeklyOffDays: number;
  consecutive: boolean;
  priorDayOffEmployeeIds?: ReadonlySet<string>;
  windowsOut?: Map<string, ReadonlySet<string>>;
}

/** One (sub-)team's OFF plan: the OFF-day count targeted and, per member, the planned consecutive window. */
interface SpecializedOffPlan {
  offTarget: number;
  windows: Map<string, ReadonlySet<string>>;
  starts: Map<string, number>;
}

function byEmployeeId(a: Employee, b: Employee): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Whether a member who already works the day indices in `worked` could ALSO
 * work day `day` and still have at least one cyclic block of `blockLength`
 * consecutive days they do not work this week (days not yet decided count as
 * free — they can still be left OFF). The sparse-week guard of
 * generateProfilingMesureShifts' WEEKLY OFF BLOCK paragraph.
 */
function consecutiveOffBlockStillPossible(worked: ReadonlySet<number>, day: number, n: number, blockLength: number): boolean {
  for (let start = 0; start < n; start++) {
    let free = true;
    for (let k = 0; k < blockLength && free; k++) {
      const i = (start + k) % n;
      if (i === day || worked.has(i)) free = false;
    }
    if (free) return true;
  }
  return false;
}

/**
 * Plans a (sub-)team's weekly OFF windows from its OWN per-day required
 * headcount — the SAME water-filling search the flexible pool uses
 * (off-window.ts's planDemandAwareOffWindows; planPreferredOffWindows is the
 * flexible pool's wrapper around it), fed with this team's demand shape
 * instead of Stage 6's estimate. Only on a full 7-day planning week (the
 * floor is defined per Monday-Sunday week — the same scope validation.ts's
 * offDayHardRulesApply uses); null otherwise.
 *
 * TARGET: Config.normal_weekly_off_days when demand allows it, never below
 * the hard floor — both lengths are tried (longest first) and the first one
 * with the smallest estimated deficit wins, so the week only falls back to
 * the floor when the normal target would leave strictly more demand short.
 * (With today's defaults both are 2, so exactly one plan is computed.)
 *
 * STREAK GUARD: a window is skipped for a member when the work run BEFORE it
 * (their real incoming streak + the days in front of the window) would
 * exceed the hard consecutive-work-day cap — a window that forces a cap
 * breach earlier in the week would just produce an extra, scattered OFF day.
 * If every window is skipped the unrestricted best window is used (same
 * "never leave someone without a window" fallback as the flexible planner).
 * Members are walked in id order (deterministic, independent of pool order;
 * all members start the week with equal usage, so this is also exactly the
 * order sortByLeastUsedFirst's stable tie-break would give an id-sorted pool).
 */
function planSpecializedOffWindows(
  daysOrder: string[],
  members: Employee[],
  requiredByDay: number[],
  rules: SpecializedOffDayRules,
  hardCaps: SpecializedHardCaps | undefined
): SpecializedOffPlan | null {
  const n = daysOrder.length;
  if (n !== 7 || members.length === 0) return null;
  const floor = Math.max(0, rules.minimumOffDaysPerWeek);
  const lengths = [...new Set([Math.max(rules.normalWeeklyOffDays, floor), floor])].filter((l) => l >= 0 && l < n);
  const ids = [...members].sort(byEmployeeId).map((e) => e.id);
  const cap = hardCaps?.caps.maxConsecutiveWorkDays;
  let best: { plan: SpecializedOffPlan | null; deficit: number } | null = null;
  for (const offTarget of lengths) {
    let candidate: { plan: SpecializedOffPlan | null; deficit: number };
    if (offTarget === 0) {
      // A floor of 0 (only reachable when configured so): "no OFF plan" is a
      // legitimate option — chosen only if the normal target would leave
      // strictly more demand short.
      candidate = { plan: null, deficit: requiredByDay.reduce((sum, r) => sum + Math.max(0, r - members.length), 0) };
    } else {
      const startAllowed = (id: string, start: number) => {
        if (rules.priorDayOffEmployeeIds?.has(id)) {
          for (let k = 0; k < offTarget; k++) if ((start + k) % n === 0) return false;
        }
        if (cap === undefined) return true;
        const wraps = start + offTarget > n;
        const before = wraps ? 0 : (hardCaps!.incomingStreakByEmployee.get(id) ?? 0) + start;
        return before <= cap;
      };
      const plan = planDemandAwareOffWindows({ daysOrder, employeeIds: ids, requiredByDay, offDaysTarget: offTarget, isAllowedStart: startAllowed, refineDeficit: true });
      candidate = { plan: { offTarget, windows: plan.windows, starts: plan.starts }, deficit: plan.deficit };
    }
    if (!best || candidate.deficit < best.deficit) best = candidate;
  }
  return best?.plan ?? null;
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
  /**
   * CAP-PACED REST PLANNING (2026-09-25 lockstep fix — cap-paced-rest.ts):
   * present only when this team's week was capacity-constrained under the
   * hard caps, so its capacity was deliberately spread across the week and
   * this day carries its proportional share of the unavoidable shortfall.
   * Only attached when at least one member was actually held back to rest
   * that day (`heldBack`, team order) — a day short for any other reason
   * (e.g. a team smaller than its headcount) keeps its original shape.
   */
  capPacing?: { teamCapacityDays: number; weekDemandDays: number; heldBack: string[] };
  /**
   * OFF/OFF PHASE 2 (2026-09-29): team members who were NOT offered this
   * day's work because it is inside their protected weekly OFF block (or,
   * with normal_off_days_consecutive off, because they already reached
   * daysOrder.length - their OFF target worked days). Present only when at
   * least one such member existed on a short day — the shortfall is then the
   * honest price of the hard weekly OFF floor, reported here rather than
   * silently splitting someone's OFF/OFF pair.
   */
  offDayProtected?: string[];
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
          }
        : undefined
    );
    if (candidates.length > 0) {
      assigned.push({ employeeId: employee.id, shiftCode: candidates[0].code });
    } else if (hardCaps) {
      // Transparency only (the decision is already made above): was this
      // member rest-legal with a compatible code, i.e. excluded by the
      // (consecutive-work-day) cap? That is the only cap left (2026-09-29
      // removal — see hard-work-caps.ts) so it is the only possible reason
      // once restOnly is non-empty.
      const restOnly = selectCompatibleShiftCodes(window.start, window.end, prior?.shift_start ?? null, prior?.shift_end ?? null, minimumRestHours, true, preferExtended, date);
      if (restOnly.length > 0) {
        capExcluded.push({ employeeId: employee.id, reason: "consecutive_work_days" });
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
    if (!conflict.capExcluded && !conflict.capPacing) {
      out.push(conflict);
      continue;
    }
    const working = new Set(day.map((a) => a.employeeId));
    const capExcluded = (conflict.capExcluded ?? []).filter((x) => !working.has(x.employeeId));
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
 * One day's demand clusters, grouped by which single catalog shift code
 * would cover them — the cap-paced planner's unit of "distinct people
 * needed" (see this function's call sites' doc comments for the bug this
 * fixes). Two clusters share a group when the SAME code is each cluster's
 * own top-ranked compatible pick: a single person on that one continuous
 * shift genuinely covers both non-overlapping windows (duty-generation,
 * Stage 9, already reuses one working person across every requirement
 * window their real shift spans — see duty-generation.ts's own busy-window
 * accumulation), so the group's real headcount need is the LARGEST single
 * cluster peak in it, not their sum. A cluster whose window no catalog code
 * covers at all gets its own singleton group (code: null) — an honest,
 * unresolvable-by-pacing shortfall, unchanged from before. Groups are
 * returned in the day's chronological order (by their earliest cluster).
 */
interface ClusterCoverageGroup {
  clusterIndices: number[];
  window: { start: string; end: string };
  headcount: number;
}

function groupCoverableClusters(
  clusters: { start: string; end: string; peak: number }[],
  minimumRestHours: number,
  preferExtended: boolean,
  date: string
): ClusterCoverageGroup[] {
  const byCode = new Map<string, number[]>();
  const singles: number[] = [];
  clusters.forEach((c, i) => {
    const top = selectCompatibleShiftCodes(c.start, c.end, null, null, minimumRestHours, true, preferExtended, date)[0];
    if (!top) {
      singles.push(i);
      return;
    }
    byCode.set(top.code, [...(byCode.get(top.code) ?? []), i]);
  });
  const groups: ClusterCoverageGroup[] = [];
  for (const idxs of byCode.values()) {
    groups.push({
      clusterIndices: idxs,
      window: {
        start: idxs.map((i) => clusters[i].start).sort()[0],
        end: idxs.map((i) => clusters[i].end).sort().slice(-1)[0],
      },
      headcount: Math.max(...idxs.map((i) => clusters[i].peak)),
    });
  }
  for (const i of singles) groups.push({ clusterIndices: [i], window: { start: clusters[i].start, end: clusters[i].end }, headcount: clusters[i].peak });
  groups.sort((a, b) => Math.min(...a.clusterIndices) - Math.min(...b.clusterIndices));
  return groups;
}

/**
 * Estimated hours of one covering shift on a Profiling/Mesure day, for the
 * cap-paced rest planner: the peak-weighted mean duration of each demand
 * cluster's top-ranked compatible catalog code (no prior-day constraint).
 * 0 when no cluster has any compatible code (nobody could cover that day).
 *
 * Deliberately still keyed on raw clusters (Σ peaks), NOT
 * groupCoverableClusters' deduped headcount: this feeds
 * planProfilingMesurePacing's WEEKLY capacityDays-vs-demandDays decision
 * (whether pacing/staggering activates for the team AT ALL) and its
 * across-week distribution — a different question from "how many DISTINCT
 * people does today need," which is what groupCoverableClusters answers
 * for assignPacedProfilingMesureDay's per-day split. Deduping here too was
 * tried and caused a regression: it can lower a team's estimated weekly
 * demand just enough to cross under its capacity, flipping pacing OFF
 * entirely for a team that still needs the across-week staggering to avoid
 * the ORIGINAL lockstep bug (sortByLeastUsedFirst's near-uniform hours
 * growth hitting the hard cap for the whole team on the same day near the
 * week's end) — see docs/known-limitations/roster-planning-vs-duty-
 * allocation.md's 2026-09-25 section. Overestimating weekly demand a
 * little is the safe direction (more staggering than strictly needed);
 * underestimating it is not (reverts to the un-staggered greedy).
 */
function estimateClusterShiftHours(clusters: { start: string; end: string; peak: number }[], minimumRestHours: number, preferExtended: boolean, date: string): number {
  let weight = 0;
  let sum = 0;
  for (const c of clusters) {
    const top = selectCompatibleShiftCodes(c.start, c.end, null, null, minimumRestHours, true, preferExtended, date)[0];
    if (!top) continue;
    sum += c.peak * getShiftDurationHours(top.code, date);
    weight += c.peak;
  }
  return weight > 0 ? sum / weight : 0;
}

/** The cap-paced rest plan for one Profiling/Mesure team (see cap-paced-rest.ts). */
function planProfilingMesurePacing(
  pool: Employee[],
  team: string,
  daysOrder: string[],
  demandByDay: Record<string, DailyDemand>,
  weekStart: string,
  minimumRestHours: number,
  preferExtended: boolean,
  hardCaps: SpecializedHardCaps
): CapPacedRestPlan {
  const demand: number[] = [];
  const hours: number[] = [];
  for (const day of daysOrder) {
    const clusters = demandClustersForRole(demandByDay[day], team);
    const est = estimateClusterShiftHours(clusters, minimumRestHours, preferExtended, flightDateFor(weekStart, day));
    // One member covers one cluster per day, so a day needs Σ peaks distinct
    // people — see this function's doc comment on why this stays
    // Σ-peaks-based rather than switching to groupCoverableClusters' dedup.
    demand.push(est > 0 ? clusters.reduce((n, c) => n + c.peak, 0) : 0);
    hours.push(est);
  }
  return planCapPacedRestDays({
    memberIds: pool.map((e) => e.id),
    daysOrder,
    demandByDay: demand,
    estimatedShiftHoursByDay: hours,
    caps: hardCaps.caps,
    incomingStreakByEmployee: hardCaps.incomingStreakByEmployee,
    maxConsecutiveOffDays: hardCaps.maxConsecutiveOffDays,
  });
}

/**
 * One cap-paced Profiling/Mesure day (see the call site). Returns, per
 * cluster (index-aligned), who was assigned and who was cap-excluded while
 * walking for it. Only ORDER and the held-back set come from the plan:
 * every assignment is made by the unchanged assignPoolToWindow.
 *
 * Walks by COVERAGE GROUP (groupCoverableClusters), not by raw cluster: two
 * clusters the same catalog code covers (e.g. a morning and a mid-morning
 * bank both inside one MT03 shift) are walked ONCE and share the resulting
 * assigned set, rather than each independently claiming its own peak's
 * worth of preferred/drawn-in people. Before this, a day's Σ-of-all-peaks
 * share split starved a later, genuinely DISTINCT-shift-needing cluster
 * (e.g. an evening AP01 bank) of people who were really only needed once
 * for the earlier, already-double-counted morning banks.
 */
function assignPacedProfilingMesureDay(
  pool: Employee[],
  clusters: { start: string; end: string; peak: number }[],
  day: string,
  dayIndex: number,
  pacing: CapPacedRestPlan,
  usageHours: Map<string, number>,
  streaks: Map<string, number>,
  priorDayShift: PriorDayShiftMap,
  minimumRestHours: number,
  preferExtended: boolean,
  date: string,
  dayCaps: PoolDayHardCaps
): { perCluster: { assigned: { employeeId: string; shiftCode: string }[]; capExcluded: { employeeId: string; reason: HardCapExclusionReason }[] }[]; heldBack: string[] } {
  const preferred = pool.filter((e) => pacing.preferredWorkDays.get(e.id)?.has(day));
  const preferredIds = new Set(preferred.map((e) => e.id));
  let preferredLeft = sortByLeastUsedFirst(preferred, usageHours);
  let drawInLeft = sortByLeastUsedFirst(
    pool.filter((e) => !preferredIds.has(e.id) && planAllowsDrawIn(pacing, e.id, dayIndex, usageHours.get(e.id) ?? 0, streaks.get(e.id) ?? 0)),
    usageHours
  );
  const offered = new Set([...preferredLeft, ...drawInLeft].map((e) => e.id));
  const groups = groupCoverableClusters(clusters, minimumRestHours, preferExtended, date);
  const groupOut = groups.map(() => ({ assigned: [] as { employeeId: string; shiftCode: string }[], capExcluded: [] as { employeeId: string; reason: HardCapExclusionReason }[] }));
  const walk = (groupIndex: number, from: Employee[], headcount: number) => {
    if (headcount <= 0 || from.length === 0) return;
    const r = assignPoolToWindow(from, groups[groupIndex].window, headcount, priorDayShift, minimumRestHours, preferExtended, date, dayCaps);
    const taken = new Set(r.assigned.map((a) => a.employeeId));
    groupOut[groupIndex].assigned.push(...r.assigned);
    for (const x of r.capExcluded) if (!groupOut[groupIndex].capExcluded.some((y) => y.employeeId === x.employeeId)) groupOut[groupIndex].capExcluded.push(x);
    preferredLeft = preferredLeft.filter((e) => !taken.has(e.id));
    drawInLeft = drawInLeft.filter((e) => !taken.has(e.id));
  };
  // Ties rotate with the day so no single group always gets the spare unit.
  // Weighted by each group's real (deduped) headcount need so a group
  // spanning several clusters no longer draws a share for each cluster it
  // covers — but NOT capped at that headcount (unlike a plain per-cluster
  // split): the day's `preferred` set was already sized by the (necessarily
  // coarser, Σ-raw-peaks) weekly plan, so on a day where the true distinct
  // need is even lower than that, the honest leftover still has to go
  // somewhere today rather than being silently benched — leaving preferred
  // members unplaced would understate this team's real worked days against
  // the weekly pacing plan's own target. Any true surplus is spread
  // proportionally to the same weights, same as the shortfall itself.
  const shares = allocateProportionally(preferred.length, groups.map((g) => g.headcount), groups.map(() => preferred.length), dayIndex);
  groups.forEach((_, k) => walk(k, preferredLeft, shares[k]));
  groups.forEach((g, k) => walk(k, [...preferredLeft, ...drawInLeft], g.headcount - groupOut[k].assigned.length));

  const out = clusters.map(() => ({ assigned: [] as { employeeId: string; shiftCode: string }[], capExcluded: [] as { employeeId: string; reason: HardCapExclusionReason }[] }));
  groups.forEach((g, k) => {
    for (const ci of g.clusterIndices) out[ci] = groupOut[k];
  });
  return { perCluster: out, heldBack: pool.filter((e) => !offered.has(e.id)).map((e) => e.id) };
}

/**
 * One Profiling/Mesure day under a weekly OFF-window plan (OFF/OFF phase 2 —
 * see generateProfilingMesureShifts' WEEKLY OFF BLOCK paragraph). `pool` is
 * already the day's offered members (window members removed) in
 * least-used-first order. Walks by COVERAGE GROUP exactly like
 * assignPacedProfilingMesureDay (groupCoverableClusters: clusters one
 * catalog code covers share the same people), but with no pacing plan: each
 * group takes up to its own deduped headcount from whoever is left, in
 * order. Without the dedup, the hard OFF windows would cost more coverage
 * than they must — the plain per-cluster greedy spends a separate person on
 * every cluster even when one shift covers two of them.
 */
function assignGroupedProfilingMesureDay(
  pool: Employee[],
  clusters: { start: string; end: string; peak: number }[],
  priorDayShift: PriorDayShiftMap,
  minimumRestHours: number,
  preferExtended: boolean,
  date: string,
  dayCaps: PoolDayHardCaps | undefined
): { assigned: { employeeId: string; shiftCode: string }[]; capExcluded: { employeeId: string; reason: HardCapExclusionReason }[] }[] {
  let left = pool;
  const groups = groupCoverableClusters(clusters, minimumRestHours, preferExtended, date);
  const out = clusters.map(() => ({ assigned: [] as { employeeId: string; shiftCode: string }[], capExcluded: [] as { employeeId: string; reason: HardCapExclusionReason }[] }));
  for (const g of groups) {
    const r = assignPoolToWindow(left, g.window, g.headcount, priorDayShift, minimumRestHours, preferExtended, date, dayCaps);
    const taken = new Set(r.assigned.map((a) => a.employeeId));
    left = left.filter((e) => !taken.has(e.id));
    const result = { assigned: r.assigned, capExcluded: r.capExcluded };
    for (const ci of g.clusterIndices) out[ci] = result;
  }
  return out;
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
  hardCaps?: SpecializedHardCaps,
  // OFF/OFF PHASE 2 (2026-09-29) — see SpecializedOffDayRules and the
  // "WEEKLY OFF BLOCK" paragraph below. Omitted = exact prior behaviour.
  offDayRules?: SpecializedOffDayRules
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
    const dayCaps: PoolDayHardCaps | undefined = hardCaps ? { caps: hardCaps.caps, streakEnteringDay: streaks } : undefined;
    // Team-local results, merged into generatedShiftsByDay/conflicts once the
    // (optional) hard-cap repair pass below has run. Same order as before.
    const teamAssignmentsByDay: Record<string, RepairSlotAssignment[]> = {};
    const teamGroupsByDay: Record<string, RepairSlotGroup[]> = {};
    const teamConflicts: { conflict: DemandConflict; groupKey: string }[] = [];
    let teamCapExclusionSeen = false;
    const poolIds = new Set(pool.map((e) => e.id));
    // CAP-PACED REST PLANNING (2026-09-25 lockstep fix — cap-paced-rest.ts):
    // decided up front from this team's real weekly demand. Inactive (and
    // the day loop below takes its original branch, byte-identical) unless
    // the team's capacity under the hard caps is below the week's demand.
    //
    // WEEKLY OFF BLOCK (2026-09-29, OFF/OFF phase 2). Before this, nothing
    // here placed OFF days at all: a member was OFF only on a day nobody
    // happened to pick them, so a busy week gave most of the team a single
    // OFF day (the reported Ayoub Chafik week, 2026-10-05). Now each member
    // gets a weekly OFF target (normal target when demand allows, never below
    // the hard floor — planSpecializedOffWindows) and the daily greedy never
    // takes it away. Two regimes, decided per team from its own week:
    //
    //  - DENSE week (the team's average demanded work days per member exceed
    //    daysOrder.length - offTarget - 1; least-used-first rotation keeps
    //    members within about a day of each other, so from there the busiest
    //    members would lose their block): each member gets ONE demand-aware
    //    consecutive window (the flexible pool's own water-filling search, fed
    //    with this team's Σ-cluster-peak headcount per day) and it is a HARD
    //    exclusion, exactly like Stage 6's hardExclude gate: the member is
    //    not offered work on their window days. Days are walked by coverage
    //    group (assignGroupedProfilingMesureDay) so the windows cost no more
    //    coverage than they must, and the window plan SUPERSEDES cap-paced
    //    rest planning — it already is a staggered, demand-aware weekly rest
    //    plan (at most 5 consecutive work days inside the week by
    //    construction, incoming streak respected by the window search), and
    //    pacing's extra hold-backs would add scattered OFF days on top of it.
    //    Tried and rejected: a SOFT window (window members offered last) plus
    //    the feasibility guard below — on the real 2026-10-05 week it let the
    //    whole team keep working early and forced everyone's block onto the
    //    weekend together (Saturday/Sunday fell to 0-2 of 12), the exact
    //    lockstep cap-paced-rest.ts exists to prevent.
    //  - SPARSE week: no window — members already get well over the floor in
    //    OFF days, and forcing specific days would only reshuffle who works
    //    (tried: it created new >max_consecutive_off_days OFF runs on the demo
    //    week's Mesure team). The original branches run unchanged, with one
    //    HARD guard: a member is not offered a day if working it would leave
    //    no possible block of offTarget consecutive non-worked days this week
    //    (cyclic) — so the floor and the block can never be lost silently.
    //
    // With normal_off_days_consecutive off there is no block to protect, only
    // the count: a member stops being offered work once they reach
    // daysOrder.length - offTarget worked days. In every regime, demand this
    // leaves uncovered is the SAME honest DemandConflict as any other
    // shortfall (BLOCKING in generate-draft-plan.ts), carrying
    // `offDayProtected` so its wording says why — never a silently split pair.
    const requiredByDay = daysOrder.map((day) => demandClustersForRole(demandByDay[day], team).reduce((sum, c) => sum + c.peak, 0));
    const offPlan = offDayRules ? planSpecializedOffWindows(daysOrder, pool, requiredByDay, offDayRules, hardCaps) : null;
    const denseWeek =
      offPlan !== null &&
      requiredByDay.reduce((sum, r) => sum + Math.min(r, pool.length), 0) / Math.max(1, pool.length) > daysOrder.length - offPlan.offTarget - 1;
    const windowsActive = offPlan !== null && offDayRules!.consecutive && denseWeek;
    if (windowsActive) for (const [id, w] of offPlan!.windows) offDayRules!.windowsOut?.set(id, w);
    const workedDays = new Map<string, number>(pool.map((e) => [e.id, 0]));
    const workedOn = new Map<string, Set<number>>(pool.map((e) => [e.id, new Set<number>()]));
    const offProtectedOn = (e: Employee, day: string): boolean => {
      if (!offPlan) return false;
      if (!offDayRules!.consecutive) return (workedDays.get(e.id) ?? 0) >= daysOrder.length - offPlan.offTarget;
      if (windowsActive) return offPlan.windows.get(e.id)?.has(day) ?? false;
      return !consecutiveOffBlockStillPossible(workedOn.get(e.id)!, daysOrder.indexOf(day), daysOrder.length, offPlan.offTarget);
    };
    const pacing = hardCaps && hardCaps.capPacing !== false && !windowsActive
      ? planProfilingMesurePacing(pool, team, daysOrder, demandByDay, weekStart, minimumRestHours, preferExtended, hardCaps)
      : null;

    daysOrder.forEach((day, dayIndex) => {
      const date = flightDateFor(weekStart, day);
      const clusters = demandClustersForRole(demandByDay[day], team);
      const dayAssignments: RepairSlotAssignment[] = [];
      const offProtected = pool.filter((e) => offProtectedOn(e, day)).map((e) => e.id);
      const offProtectedIds = new Set(offProtected);
      const dayPool = offProtected.length > 0 ? pool.filter((e) => !offProtectedIds.has(e.id)) : pool;
      const offNote = offProtected.length > 0 ? { offDayProtected: offProtected } : {};
      let remainingPool = sortByLeastUsedFirst(dayPool, usageHours);
      teamGroupsByDay[day] = [];

      if (windowsActive) {
        // WEEKLY OFF BLOCK: the day's offered members (window members already
        // removed), least-used first, walked by coverage group.
        const grouped = assignGroupedProfilingMesureDay(remainingPool, clusters, priorDayShift, minimumRestHours, preferExtended, date, dayCaps);
        clusters.forEach((cluster, clusterIndex) => {
          const groupKey = `${team}-${day}-${clusterIndex}`;
          teamGroupsByDay[day].push({ key: groupKey, window: { start: cluster.start, end: cluster.end }, needed: cluster.peak, eligibleIds: poolIds });
          const { assigned, capExcluded } = grouped[clusterIndex];
          dayAssignments.push(...assigned.map((a) => ({ ...a, groupKey })));
          for (const x of capExcluded) hardCaps?.exclusionsOut?.push({ employeeId: x.employeeId, dayOfWeek: day, population: "profiling_mesure", reason: x.reason });
          if (capExcluded.length > 0) teamCapExclusionSeen = true;
          const shortfall = Math.max(0, cluster.peak - assigned.length);
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
                ...offNote,
              },
            });
          }
        });
      } else if (pacing?.active) {
        // Preferred workers first (least-used among them), shared across the
        // day's clusters in proportion to each cluster's peak; then every
        // cluster's remaining need from any preferred worker left over and
        // the members the plan lets be drawn in. Members held back to rest
        // are never offered today's work. Every walk is the unchanged
        // assignPoolToWindow — the same rest/hard-cap filter as always.
        const paced = assignPacedProfilingMesureDay(dayPool, clusters, day, dayIndex, pacing, usageHours, streaks, priorDayShift, minimumRestHours, preferExtended, date, dayCaps!);
        clusters.forEach((cluster, clusterIndex) => {
          const groupKey = `${team}-${day}-${clusterIndex}`;
          teamGroupsByDay[day].push({ key: groupKey, window: { start: cluster.start, end: cluster.end }, needed: cluster.peak, eligibleIds: poolIds });
          const { assigned, capExcluded } = paced.perCluster[clusterIndex];
          dayAssignments.push(...assigned.map((a) => ({ ...a, groupKey })));
          for (const x of capExcluded) hardCaps?.exclusionsOut?.push({ employeeId: x.employeeId, dayOfWeek: day, population: "profiling_mesure", reason: x.reason });
          if (capExcluded.length > 0) teamCapExclusionSeen = true;
          const shortfall = Math.max(0, cluster.peak - assigned.length);
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
                ...(paced.heldBack.length > 0 ? { capPacing: { teamCapacityDays: pacing.capacityDays, weekDemandDays: pacing.demandDays, heldBack: paced.heldBack } } : {}),
                ...offNote,
              },
            });
          }
        });
      } else clusters.forEach((cluster, clusterIndex) => {
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
              ...offNote,
            },
          });
        }
      });

      teamAssignmentsByDay[day] = dayAssignments;
      // A cap-paced coverage group spanning multiple clusters (see
      // assignPacedProfilingMesureDay) puts the SAME employee+shiftCode into
      // dayAssignments once per covered cluster (one groupKey each, all
      // legitimately counting toward that cluster's own coverage) — dedupe
      // by employee here so their one real shift's hours are only counted
      // once (every duplicate entry for a given employee this day shares
      // the same shiftCode, so which one is kept doesn't matter).
      const uniqueDayAssignments = new Map<string, RepairSlotAssignment>();
      for (const a of dayAssignments) uniqueDayAssignments.set(a.employeeId, a);
      for (const a of uniqueDayAssignments.values()) {
        usageHours.set(a.employeeId, (usageHours.get(a.employeeId) ?? 0) + getShiftDurationHours(a.shiftCode, date));
      }

      const nextPriorDayShift: PriorDayShiftMap = new Map();
      for (const employee of pool) {
        const a = dayAssignments.find((x) => x.employeeId === employee.id);
        nextPriorDayShift.set(employee.id, a ? getShiftTimesAs(a.shiftCode, date) : null);
      }
      priorDayShift = nextPriorDayShift;
      advanceStreaks(pool, streaks, new Set(dayAssignments.map((a) => a.employeeId)));
      for (const id of uniqueDayAssignments.keys()) {
        workedDays.set(id, (workedDays.get(id) ?? 0) + 1);
        workedOn.get(id)?.add(dayIndex);
      }
    });

    // HARD-CAP REPAIR (2026-09-25, phase 2 part B — hard-cap-repair.ts): only
    // when a hard cap excluded someone in this team (or the week was
    // cap-paced, i.e. capacity-constrained) AND a real shortfall remains.
    // Otherwise nothing below runs and the output is byte-identical.
    let finalAssignmentsByDay = teamAssignmentsByDay;
    let finalConflicts = teamConflicts.map((c) => c.conflict);
    let teamRepairs: HardCapRepair[] = [];
    if (hardCaps && hardCaps.repair !== false && (teamCapExclusionSeen || pacing?.active) && teamConflicts.length > 0) {
      const result = repairSlotPopulationGaps({
        population: "profiling_mesure",
        team,
        ctx: { daysOrder, weekStart, minimumRestHours, caps: hardCaps.caps, incomingStreakByEmployee: hardCaps.incomingStreakByEmployee, priorWeekBoundaryContext },
        preferExtended,
        poolIds: pool.map((e) => e.id),
        names: new Map(pool.map((e) => [e.id, e.name])),
        groupsByDay: teamGroupsByDay,
        assignmentsByDay: teamAssignmentsByDay,
        ...(offDayRules ? { offDayRules: { minimumOffDays: offDayRules.minimumOffDaysPerWeek, consecutive: offDayRules.consecutive } } : {}),
      });
      teamRepairs = result.repairs;
      hardCaps.repairsOut?.push(...result.repairs);
      finalAssignmentsByDay = result.assignmentsByDay;
      finalConflicts = recomputeSlotConflicts(teamConflicts, finalAssignmentsByDay, result.search);
    }

    for (const day of daysOrder) {
      if (!generatedShiftsByDay[day]) generatedShiftsByDay[day] = [];
      // Same dedupe as usageHours above: a coverage-group employee appears
      // once per cluster's groupKey in finalAssignmentsByDay, but is one
      // real person on one real shift — exactly one roster row per day.
      const seen = new Set<string>();
      for (const a of finalAssignmentsByDay[day] ?? []) {
        if (seen.has(a.employeeId)) continue;
        seen.add(a.employeeId);
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
 * The cap-paced rest plan(s) for one foreign-company team (see
 * cap-paced-rest.ts): one per confirmed role sub-team (ACE / Leader), or one
 * for the whole team without a split. A day's demand is the sub-team's
 * confirmed headcount on a real flight day; its estimated hours are the
 * top-ranked compatible code for that day's protected window. `byMember`
 * only holds members of an ACTIVE sub-plan — anyone else keeps the original
 * least-used ordering.
 */
function planForeignCompanyPacing(
  pool: Employee[],
  roleConfig: TeamRoleConfig | null,
  headcount: number,
  daysOrder: string[],
  dayPlans: Map<string, ReturnType<typeof planForeignCompanyDay>>,
  weekStart: string,
  minimumRestHours: number,
  preferExtended: boolean,
  hardCaps: SpecializedHardCaps
): { active: boolean; byMember: Map<string, CapPacedRestPlan>; capacityDays: number; demandDays: number } {
  const hours = daysOrder.map((day) => {
    const plan = dayPlans.get(day);
    if (!plan) return 0;
    const date = flightDateFor(weekStart, day);
    const top = selectCompatibleShiftCodes(plan.combinedWindow.start, plan.combinedWindow.end, null, null, minimumRestHours, true, preferExtended, date)[0];
    return top ? getShiftDurationHours(top.code, date) : 0;
  });
  const { aces, leaders } = partitionPoolByRole(pool, roleConfig);
  const subTeams = roleConfig ? [{ members: aces, need: roleConfig.aceCount }, { members: leaders, need: roleConfig.leaderCount }] : [{ members: pool, need: headcount }];
  const byMember = new Map<string, CapPacedRestPlan>();
  let capacityDays = 0;
  let demandDays = 0;
  // Planned (or, for an inactive sub-plan, full) coverage per day so far, as
  // a ratio of the company's headcount — the next sub-team's tie-break.
  const coveredSoFar = daysOrder.map(() => 0);
  for (const { members, need } of subTeams) {
    const sub = planCapPacedRestDays({
      memberIds: members.map((e) => e.id),
      daysOrder,
      demandByDay: hours.map((h) => (h > 0 ? need : 0)),
      estimatedShiftHoursByDay: hours,
      caps: hardCaps.caps,
      incomingStreakByEmployee: hardCaps.incomingStreakByEmployee,
      maxConsecutiveOffDays: hardCaps.maxConsecutiveOffDays,
      siblingCoverageByDay: coveredSoFar.map((c) => c / Math.max(1, headcount)),
    });
    hours.forEach((h, i) => (coveredSoFar[i] += h > 0 ? (sub.active ? sub.plannedWorkersByDay[i] : Math.min(need, members.length)) : 0));
    capacityDays += sub.capacityDays;
    demandDays += sub.demandDays;
    if (sub.active) for (const e of members) byMember.set(e.id, sub);
  }
  return { active: byMember.size > 0, byMember, capacityDays, demandDays };
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
  config?: Pick<Config, "normal_weekly_off_days"> & Partial<Pick<Config, "max_consecutive_off_days" | "minimum_off_days_per_planning_week" | "normal_off_days_consecutive">>,
  // FATIGUE-AWARE DISTRIBUTION (2026-09-24, part 2) — see
  // ForeignFatigueOptions and the "FATIGUE" paragraph of this function's
  // doc comment. Optional; omitted or disabled = exact prior behaviour.
  fatigue?: ForeignFatigueOptions,
  // HARD WORK CAPS (2026-09-25, phase 1) — see SpecializedHardCaps. Applied
  // to flight days (selectCompatibleShiftCodes' filter) AND to the normal
  // RAM roster top-up (computeEmployeeDayCountTopUp's legalCodesAt).
  hardCaps?: SpecializedHardCaps,
  // OFF/OFF PHASE 2 (2026-09-29) — see the "WEEKLY OFF WINDOW" paragraph in
  // the body. Only meaningful together with `config` (the top-up it feeds);
  // when omitted but `config` is given, the rules are read from `config`
  // (floor defaulting to normal_weekly_off_days, consecutive to true — the
  // confirmed defaults). No `config` = no OFF planning, exact prior output.
  offDayRules?: SpecializedOffDayRules
): { generatedShiftsByDay: Record<string, GeneratedShiftAssignment[]>; conflicts: DemandConflict[] } {
  const generatedShiftsByDay: Record<string, GeneratedShiftAssignment[]> = {};
  const conflicts: DemandConflict[] = [];
  const fatigueActive = fatigue?.config.enabled === true;
  const foreignOffRules: SpecializedOffDayRules | undefined = config
    ? offDayRules ?? {
        minimumOffDaysPerWeek: config.minimum_off_days_per_planning_week ?? config.normal_weekly_off_days,
        normalWeeklyOffDays: config.normal_weekly_off_days,
        consecutive: config.normal_off_days_consecutive ?? true,
      }
    : undefined;

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
    const dayCaps: PoolDayHardCaps | undefined = hardCaps ? { caps: hardCaps.caps, streakEnteringDay: streaks } : undefined;
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
    // Each day's real flight plan (pure; computed once, read by the pacing
    // planner and the day loop).
    const dayPlans = new Map(daysOrder.map((day) => [day, planForeignCompanyDay(company, day, flights, undefined, undefined, undefined, flightDateFor(weekStart, day))]));
    // CAP-PACED REST PLANNING (2026-09-25 lockstep fix — cap-paced-rest.ts),
    // per role sub-team. Inactive (original ordering, byte-identical) unless
    // a sub-team's capacity under the hard caps is below its flight-day demand.
    const pacing = hardCaps && hardCaps.capPacing !== false && headcount !== undefined
      ? planForeignCompanyPacing(pool, roleConfig, headcount, daysOrder, dayPlans, weekStart, minimumRestHours, preferExtended, hardCaps)
      : null;
    // WEEKLY OFF WINDOW (2026-09-29, OFF/OFF phase 2). Before this, the
    // top-up below was handed `preferredOffWindowStart: undefined`, so a
    // foreign-company member's OFF block was only ever the earliest of the
    // equally-free windows left over after flight days — never demand-aware.
    // Now each role sub-team (ACE / Leader for a confirmed split, else the
    // whole team) gets the SAME demand-aware water-filling windows as every
    // other generation-driven population (planSpecializedOffWindows), with the
    // company's confirmed headcount on each real flight day as that day's
    // requirement (0 on a non-flight day — so OFF blocks land on non-flight
    // days first, spread across the team). The window is used twice:
    //   - flight days: a member whose window contains today is offered the
    //     company commitment LAST (after every other offered member). This is
    //     ordering only — the walk still tries everyone until the confirmed
    //     headcount is met, so a protected commitment is never left short to
    //     protect an OFF day (an unavoidable breach is then flagged by
    //     validation.ts as insufficient_off_days / off_days_not_consecutive,
    //     never hidden);
    //   - the top-up: its start index is computeEmployeeDayCountTopUp's
    //     `preferredOffWindowStart`, i.e. chooseTopUpReservedOffDays'
    //     tie-break among the equally-free candidate blocks.
    let foreignOffPlan: SpecializedOffPlan | null = null;
    if (foreignOffRules && headcount !== undefined) {
      const { aces, leaders } = partitionPoolByRole(pool, roleConfig);
      const subTeams = roleConfig ? [{ members: aces, need: roleConfig.aceCount }, { members: leaders, need: roleConfig.leaderCount }] : [{ members: pool, need: headcount }];
      for (const { members, need } of subTeams) {
        const sub = planSpecializedOffWindows(daysOrder, members, daysOrder.map((d) => (dayPlans.get(d) ? need : 0)), foreignOffRules, hardCaps);
        if (!sub) continue;
        if (!foreignOffPlan) foreignOffPlan = { offTarget: sub.offTarget, windows: new Map(), starts: new Map() };
        foreignOffPlan.offTarget = Math.max(foreignOffPlan.offTarget, sub.offTarget);
        for (const [id, w] of sub.windows) foreignOffPlan.windows.set(id, w);
        for (const [id, st] of sub.starts) foreignOffPlan.starts.set(id, st);
      }
      if (foreignOffPlan && foreignOffRules.consecutive) for (const [id, w] of foreignOffPlan.windows) foreignOffRules.windowsOut?.set(id, w);
    }
    const inOwnWindow = (id: string, day: string) => Boolean(foreignOffRules?.consecutive && foreignOffPlan?.windows.get(id)?.has(day));

    for (const day of daysOrder) {
      const date = flightDateFor(weekStart, day);
      const dayIndex = daysOrder.indexOf(day);
      const plan = dayPlans.get(day) ?? null;
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
        // PACING: members on a preferred work day first, then members the
        // plan lets be drawn in (least-used order kept within each segment);
        // members held back to rest are not offered today's commitment.
        let segmentOf: Map<string, number> | null = null;
        let heldBack: string[] = [];
        if (pacing?.active) {
          const preferred: Employee[] = [];
          const drawIn: Employee[] = [];
          for (const e of orderedPool) {
            const p = pacing.byMember.get(e.id);
            if (!p || p.preferredWorkDays.get(e.id)?.has(day)) preferred.push(e);
            else if (planAllowsDrawIn(p, e.id, dayIndex, usageHours.get(e.id) ?? 0, streaks.get(e.id) ?? 0)) drawIn.push(e);
          }
          orderedPool = [...preferred, ...drawIn];
          const offered = new Set(orderedPool.map((e) => e.id));
          heldBack = pool.filter((e) => !offered.has(e.id)).map((e) => e.id);
          segmentOf = new Map<string, number>([...preferred.map((e) => [e.id, 0] as [string, number]), ...drawIn.map((e) => [e.id, 1] as [string, number])]);
        }
        // WEEKLY OFF WINDOW: members inside their own window go last (stable).
        if (orderedPool.some((e) => inOwnWindow(e.id, day))) {
          orderedPool = [...orderedPool.filter((e) => !inOwnWindow(e.id, day)), ...orderedPool.filter((e) => inOwnWindow(e.id, day))];
          const seg = new Map<string, number>(orderedPool.map((e) => [e.id, (segmentOf?.get(e.id) ?? 0) + (inOwnWindow(e.id, day) ? 2 : 0)]));
          segmentOf = seg;
        }
        const baseOrder = orderedPool;
        const projections = new Map<string, FatigueCandidateProjection>();
        if (ledger && plan.shiftCode) {
          for (const e of pool) {
            projections.set(e.id, projectFatigueForShift(e.id, ledger.states.get(e.id)!, ledger.lastWorked.get(e.id), plan.shiftCode, date, ledger.config));
          }
          const steps = (id: string) => fatigueScoreSteps(projections.get(id)!.after.accumulatedBurden);
          orderedPool = orderedPool
            .map((e, k) => ({ e, k, s: steps(e.id), seg: segmentOf?.get(e.id) ?? 0 }))
            .sort((a, b) => a.seg - b.seg || a.s - b.s || a.k - b.k)
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
              ...(pacing?.active && heldBack.length > 0 ? { capPacing: { teamCapacityDays: pacing.capacityDays, weekDemandDays: pacing.demandDays, heldBack } } : {}),
            },
          });
        }
        if (ledger && plan.shiftCode) {
          // Explainability: re-run the SAME (pure) walk with the pre-fatigue
          // order to see whom fatigue displaced. Each member fatigue brought
          // in is explained against a displaced member (in order); a member
          // selected either way gets [] (fatigue did not change that pick).
          const withoutFatigue = assignPoolToWindowWithRoles(
            baseOrder, plan.combinedWindow, headcount, roleConfig, priorDayShift, minimumRestHours, preferExtended, date, dayCaps
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
    if (hardCaps && hardCaps.repair !== false && (companyCapExclusionSeen || pacing?.active) && companyConflicts.length > 0) {
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
        ...(foreignOffRules ? { offDayRules: { minimumOffDays: foreignOffRules.minimumOffDaysPerWeek, consecutive: foreignOffRules.consecutive } } : {}),
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
        // PART A (2026-09-25, hard-constraints phase 2) used to compute this
        // member's own CAP-AWARE target here (roster-target.ts) when hard
        // caps were in force — an HOURS-based reduction of the normal
        // target. REMOVED 2026-09-29 (see hard-work-caps.ts's removal
        // note): the fixed normal target is used unconditionally now,
        // exactly as the no-hard-caps case always did.
        // OFF/OFF phase 2: the planned OFF target (normal when demand allows,
        // never below the hard floor) sizes both the target and the block.
        const targetWorkingDaysThisWindow = foreignOffPlan ? Math.max(0, daysOrder.length - foreignOffPlan.offTarget) : normalTargetWorkDays;
        const offWindowLength = foreignOffPlan ? foreignOffPlan.offTarget : config.normal_weekly_off_days;
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
          undefined, // t1PeakDemandMinuteByDay — not applicable to a foreign-company team
          // OFF/OFF phase 2: this member's demand-aware window (see WEEKLY OFF
          // WINDOW above) — previously always undefined.
          foreignOffPlan?.starts.get(employee.id),
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
