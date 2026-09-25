import { Employee } from "../types";
import { getShiftTimesAs, getShiftDurationHours, shiftCatalogForDate } from "../shift-templates";
import { flightDateFor } from "../flight-date";
import { restHoursBetween } from "../roster-generation";
import { selectCompatibleShiftCodes } from "../foreign-shift-planning";
import { DailyDemand } from "./demand-aggregation";
import { GeneratedShiftAssignment, PriorDayShiftMap, replayStage6HardCoverage, STAGE6_DEFAULT_ROLES } from "./shift-generation";
import { HardWorkCaps, HardCapExclusion, HardCapExclusionReason, wouldExceedHardWeeklyHoursCap } from "./hard-work-caps";
import { maxConsecutiveOffCyclic } from "./consecutive-off";
import { isEligibleForDefaultCheckinPlacement } from "./checkin-zone-placement";

/**
 * BOUNDED CROSS-EMPLOYEE HARD-CAP REPAIR (2026-09-25, hard-constraints
 * milestone PHASE 2, part B).
 *
 * THE PROBLEM. Phase 1 made two caps hard (max 5 consecutive work days, a
 * hard single-week hours cap) as pre-scoring filters inside each greedy,
 * day-by-day generator. A greedy has no lookahead: it can spend employee X's
 * cap headroom on a day that another eligible employee Y could have covered
 * just as well, and then find X — the only person left who could cover a
 * later need — blocked by the cap. The result is an avoidable gap (an
 * uncovered demand slot) or an avoidable roster dead-end (a 3-day OFF run
 * because the hours cap closed the end of X's week).
 *
 * THE MECHANISM — one move type, an "ejection chain of length 1":
 *
 *   X is blocked (by a HARD CAP, not by rest or qualification) from covering
 *   need N on day u. X works some other day d. If an eligible Y who is OFF
 *   on d can take X's day-d work, legally, then:
 *       Y takes day d (same need, a code legal for Y),
 *       X is freed on day d, and
 *       X covers N on day u.
 *   Coverage of day d is unchanged (Y replaces X in the same slot); day u
 *   gains the missing person. Nobody else's roster changes.
 *
 * Every candidate move is accepted only if BOTH X's and Y's resulting WHOLE
 * weeks stay legal: 15h rest against both calendar neighbours of every day
 * that changed (and against the prior week's real boundary shift on the
 * first day, and the same-week Sunday<->Monday wrap for a 7-day window —
 * the convention Stage 6's forward lookahead and the top-up already use),
 * the consecutive-work-day cap over the whole week counted from the real
 * incoming streak, the hard weekly hours cap over the whole week, and the
 * need's own qualification/role/window compatibility (the same
 * selectCompatibleShiftCodes / Stage-6 skill rules the greedy uses). Fixed-
 * cycle and static employees are never in any population handed to this
 * module, so they cannot be touched.
 *
 * Two uses:
 *   - GAP repair (Profiling/Mesure demand clusters, foreign-company flight
 *     days, flexible-pool Stage-6 demand): runs only when the greedy
 *     recorded a hard-cap exclusion AND left a real shortfall.
 *   - OFF-RUN repair (flexible pool only): an employee whose final week
 *     (Stage 6 + the roster top-up) has an OFF block longer than
 *     max_consecutive_off_days after a hard cap closed part of their week —
 *     phase 1's youssef-el-amrani case (Mon-Thu worked, the 42h cap closes
 *     Fri-Sun). Two moves, in this order: (a) X shifts one of their OWN
 *     Stage-6 days to a free day (nobody else touched) — allowed only where
 *     what X leaves behind is demand a dedicated team (Profiling/Mesure)
 *     fully covers that day; (b) the hand-off above: Y takes one of X's
 *     Stage-6 days and the top-up (the exact same algorithm, simulated)
 *     refills X's week elsewhere. Accepted only if X's OFF blocks now respect
 *     the rule, nobody newly breaks it, and nobody loses a rostered day.
 *
 * COVERAGE is never traded away: a hand-off requires Y to cover every
 * (bucket, role) unit X's shift covered (flexible pool: Stage 6's own
 * accounting, replayed — replayStage6HardCoverage; slot populations: the
 * same need slot), and a gap repair must strictly add coverage where it was
 * short. The one relaxation is Stage 6's known double count of Profiling/
 * Mesure demand: a unit of those roles on a day the dedicated team fully
 * covers is not a real gap and may be left to that team.
 *
 * DETERMINISM: every choice iterates an explicitly sorted list — gaps by
 * (day index, need order), candidates X by employee id, X's days by day
 * index, replacements Y by (hours already rostered this week ascending,
 * then employee id), codes by the generator's own ranking. No Map/Set
 * iteration order is relied on for a decision. Same input -> same output.
 *
 * BOUND: at most HARD_CAP_REPAIR_ATTEMPT_BUDGET candidate evaluations per
 * population per team per week (mirroring roster-generation.ts's
 * TOP_UP_SEARCH_NODE_BUDGET precedent). Each APPLIED move strictly reduces
 * the population's total shortfall (gap repair) or removes one employee's
 * OFF-rule breach while creating none (OFF-run repair), so the number of
 * applied moves is also finite. A move is applied atomically only after it
 * is fully verified, so an exhausted budget leaves the plan in the last
 * fully-legal state — never half-repaired — and the remaining gap is
 * reported exactly as phase 1 does, noting that the search ran.
 *
 * WHAT IT CANNOT DO (by design): chains longer than one hand-off (Y may not
 * in turn hand one of their own days to a Z), moves between populations, or
 * inventing capacity. A structural shortfall — e.g. Gulf Air, where the whole
 * 8-person team is needed on every flight day and 4 x 11.25h > 42h for
 * everyone — has no Y who is OFF on any of X's days, so no move exists and
 * the BLOCKING gap stays reported honestly.
 */

/** Max candidate evaluations per population/team/week. See the BOUND paragraph above. */
export const HARD_CAP_REPAIR_ATTEMPT_BUDGET = 2000;

const HOURS_EPSILON = 1e-9;

export type HardCapRepairPopulation = "flexible_pool" | "profiling_mesure" | "foreign_company";

/** One applied reallocation — the transparency record parallel to HardCapExclusion. */
export interface HardCapRepair {
  population: HardCapRepairPopulation;
  /** Team name for Profiling/Mesure/foreign; "General T1 Pool" for the flexible pool. */
  team: string;
  /**
   *  - reallocate_for_gap: X handed `reassignedDay` to Y and then covered the short need on `targetDay`.
   *  - direct_fill_after_reallocation: an earlier move freed enough headroom that `filledByEmployeeId` could cover `targetDay` directly.
   *  - reallocate_for_off_run: X handed `reassignedDay` to Y so the roster top-up could place X's remaining day(s) without an over-long OFF block.
   *  - shift_own_day_for_off_run: X's own Stage-6 day `reassignedDay` moved to `targetDay` (nobody else touched) to break an over-long OFF block.
   */
  kind: "reallocate_for_gap" | "direct_fill_after_reallocation" | "reallocate_for_off_run" | "shift_own_day_for_off_run";
  targetDay: string;
  reassignedDay: string | null;
  fromEmployeeId: string | null;
  toEmployeeId: string | null;
  filledByEmployeeId: string | null;
  reassignedShiftCode: string | null;
  targetShiftCode: string | null;
  /** The hard cap that blocked X before the move. */
  cap: HardCapExclusionReason | null;
  explanation: string;
}

/** Search bookkeeping reported back to callers (for the BLOCKING wording). */
export interface HardCapRepairSearch {
  attemptsUsed: number;
  budget: number;
  budgetExhausted: boolean;
}

type Times = { shift_start: string; shift_end: string };

/** The per-employee legality context every move is checked against. */
export interface RepairLegalityContext {
  daysOrder: string[];
  weekStart: string;
  minimumRestHours: number;
  caps: HardWorkCaps;
  incomingStreakByEmployee: ReadonlyMap<string, number>;
  priorWeekBoundaryContext: PriorDayShiftMap;
}

/** A week pattern: one shift code (or null = OFF) per daysOrder index. */
export type WeekPattern = (string | null)[];

function timesAt(ctx: RepairLegalityContext, code: string, index: number): Times {
  return getShiftTimesAs(code, flightDateFor(ctx.weekStart, ctx.daysOrder[index]));
}

/** 15h rest for `code` placed on day `j` of `pattern`, against both neighbours (prior-week boundary on day 0; same-week wrap for a 7-day window). */
export function restLegalAt(ctx: RepairLegalityContext, employeeId: string, pattern: WeekPattern, j: number, code: string): boolean {
  const n = ctx.daysOrder.length;
  const me = timesAt(ctx, code, j);
  const priors: (Times | null)[] = [];
  if (j > 0) priors.push(pattern[j - 1] ? timesAt(ctx, pattern[j - 1]!, j - 1) : null);
  else {
    priors.push(ctx.priorWeekBoundaryContext.get(employeeId) ?? null);
    if (n === 7 && pattern[n - 1]) priors.push(timesAt(ctx, pattern[n - 1]!, n - 1));
  }
  for (const p of priors) if (p && restHoursBetween(p.shift_start, p.shift_end, me.shift_start) < ctx.minimumRestHours) return false;
  const nextIndex = j + 1 < n ? j + 1 : n === 7 ? 0 : -1;
  if (nextIndex >= 0 && nextIndex !== j && pattern[nextIndex]) {
    const next = timesAt(ctx, pattern[nextIndex]!, nextIndex);
    if (restHoursBetween(me.shift_start, me.shift_end, next.shift_start) < ctx.minimumRestHours) return false;
  }
  return true;
}

/** The first hard cap a whole-week pattern breaks, or null when it respects both (streak counted from the real incoming streak). */
export function hardCapBreach(ctx: RepairLegalityContext, employeeId: string, pattern: WeekPattern): HardCapExclusionReason | null {
  let streak = ctx.incomingStreakByEmployee.get(employeeId) ?? 0;
  let hours = 0;
  for (let i = 0; i < pattern.length; i++) {
    const code = pattern[i];
    if (!code) {
      streak = 0;
      continue;
    }
    if (streak + 1 > ctx.caps.maxConsecutiveWorkDays) return "consecutive_work_days";
    streak++;
    hours += getShiftDurationHours(code, flightDateFor(ctx.weekStart, ctx.daysOrder[i]));
  }
  if (wouldExceedHardWeeklyHoursCap(hours, 0, ctx.caps.hardWeeklyHoursCap)) return "hard_weekly_hours";
  return null;
}

function patternHours(ctx: RepairLegalityContext, pattern: WeekPattern): number {
  let h = 0;
  pattern.forEach((code, i) => {
    if (code) h += getShiftDurationHours(code, flightDateFor(ctx.weekStart, ctx.daysOrder[i]));
  });
  return h;
}

function withDay(pattern: WeekPattern, j: number, code: string | null): WeekPattern {
  const copy = [...pattern];
  copy[j] = code;
  return copy;
}

function capPhrase(reason: HardCapExclusionReason | null, caps: HardWorkCaps): string {
  if (reason === "consecutive_work_days") return `the ${caps.maxConsecutiveWorkDays}-consecutive-work-day cap`;
  if (reason === "hard_weekly_hours") return `the ${caps.hardWeeklyHoursCap}h hard weekly hours cap`;
  return "the hard work caps";
}

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// SLOT POPULATIONS — Profiling/Mesure demand clusters, foreign-company flight days
// ---------------------------------------------------------------------------

/** One need on one day: `needed` people from `eligibleIds`, each on a code compatible with `window`. */
export interface RepairSlotGroup {
  key: string;
  window: { start: string; end: string };
  needed: number;
  eligibleIds: ReadonlySet<string>;
}

export interface RepairSlotAssignment {
  employeeId: string;
  shiftCode: string;
  groupKey: string;
}

export interface SlotRepairInput {
  population: "profiling_mesure" | "foreign_company";
  team: string;
  ctx: RepairLegalityContext;
  /** selectCompatibleShiftCodes' preferExtended for this team (teams.ts's isShiftExtensionPreferred). */
  preferExtended: boolean;
  /** Every member of the team's pool (order irrelevant — sorted internally). */
  poolIds: string[];
  names: ReadonlyMap<string, string>;
  groupsByDay: Record<string, RepairSlotGroup[]>;
  assignmentsByDay: Record<string, RepairSlotAssignment[]>;
  budget?: number;
}

export interface SlotRepairResult {
  /** The repaired assignments (the SAME object as the input when no move was applied). */
  assignmentsByDay: Record<string, RepairSlotAssignment[]>;
  repairs: HardCapRepair[];
  search: HardCapRepairSearch;
}

/**
 * Gap repair for a slot-shaped population (see the module doc comment).
 * Callers invoke it only when the greedy recorded at least one hard-cap
 * exclusion for this team AND left a shortfall; otherwise it is never run
 * (a pure no-op by construction). Returns the input object untouched when
 * no move is found.
 */
export function repairSlotPopulationGaps(input: SlotRepairInput): SlotRepairResult {
  const { ctx, groupsByDay, names } = input;
  const budget = input.budget ?? HARD_CAP_REPAIR_ATTEMPT_BUDGET;
  const n = ctx.daysOrder.length;
  const poolIds = [...input.poolIds].sort(byId);
  const nameOf = (id: string) => names.get(id) ?? id;

  // Working state: a pattern per employee and which group they fill each day.
  const patterns = new Map<string, WeekPattern>(poolIds.map((id) => [id, Array<string | null>(n).fill(null)]));
  const groupAt = new Map<string, string>(); // `${id}|${j}` -> groupKey
  const assignments: Record<string, RepairSlotAssignment[]> = {};
  ctx.daysOrder.forEach((day, j) => {
    assignments[day] = [...(input.assignmentsByDay[day] ?? [])];
    for (const a of assignments[day]) {
      patterns.get(a.employeeId)?.splice(j, 1, a.shiftCode);
      groupAt.set(`${a.employeeId}|${j}`, a.groupKey);
    }
  });

  let attempts = 0;
  let exhausted = false;
  let changed = false;
  const repairs: HardCapRepair[] = [];
  const spend = (): boolean => {
    if (attempts >= budget) {
      exhausted = true;
      return false;
    }
    attempts++;
    return true;
  };

  const shortOf = (day: string, g: RepairSlotGroup) => g.needed - assignments[day].filter((a) => a.groupKey === g.key).length;
  const worksOn = (id: string, j: number) => Boolean(patterns.get(id)?.[j]);

  /** The code the greedy's own ranking would give `id` for `window` on day j of `pattern`, filtered by whole-week legality; null if none. */
  const pickCode = (id: string, j: number, window: { start: string; end: string }, pattern: WeekPattern, applyCaps: boolean): string | null => {
    const prior = j > 0 ? (pattern[j - 1] ? timesAt(ctx, pattern[j - 1]!, j - 1) : null) : ctx.priorWeekBoundaryContext.get(id) ?? null;
    const date = flightDateFor(ctx.weekStart, ctx.daysOrder[j]);
    const candidates = selectCompatibleShiftCodes(window.start, window.end, prior?.shift_start ?? null, prior?.shift_end ?? null, ctx.minimumRestHours, true, input.preferExtended, date);
    for (const c of candidates) {
      if (!restLegalAt(ctx, id, pattern, j, c.code)) continue;
      if (applyCaps && hardCapBreach(ctx, id, withDay(pattern, j, c.code)) !== null) continue;
      return c.code;
    }
    return null;
  };

  const place = (id: string, j: number, code: string, groupKey: string) => {
    const day = ctx.daysOrder[j];
    patterns.get(id)!.splice(j, 1, code);
    groupAt.set(`${id}|${j}`, groupKey);
    assignments[day].push({ employeeId: id, shiftCode: code, groupKey });
  };

  const tryFill = (u: number, g: RepairSlotGroup): boolean => {
    const dayU = ctx.daysOrder[u];
    const candidatesX = poolIds.filter((id) => g.eligibleIds.has(id) && !worksOn(id, u));

    // (1) Direct fill — only meaningful once an earlier move changed someone's week.
    if (changed) {
      for (const x of candidatesX) {
        if (!spend()) return false;
        const code = pickCode(x, u, g.window, patterns.get(x)!, true);
        if (!code) continue;
        place(x, u, code, g.key);
        repairs.push({
          population: input.population, team: input.team, kind: "direct_fill_after_reallocation", targetDay: dayU,
          reassignedDay: null, fromEmployeeId: null, toEmployeeId: null, filledByEmployeeId: x, reassignedShiftCode: null, targetShiftCode: code, cap: null,
          explanation: `${nameOf(x)} now covers ${dayU}'s ${input.team} need (${code}): an earlier reallocation in this week freed the headroom the hard caps had closed.`,
        });
        return true;
      }
    }

    // (2) Ejection chain of length 1.
    for (const x of candidatesX) {
      const base = patterns.get(x)!;
      // X must be blocked by a CAP only: a rest-legal, compatible code exists ignoring the caps.
      if (!pickCode(x, u, g.window, base, false)) continue;
      const cap = (() => {
        const code = pickCode(x, u, g.window, base, false)!;
        return hardCapBreach(ctx, x, withDay(base, u, code));
      })();
      for (let d = 0; d < n; d++) {
        if (d === u || !base[d]) continue;
        const groupKeyD = groupAt.get(`${x}|${d}`);
        const groupD = (groupsByDay[ctx.daysOrder[d]] ?? []).find((h) => h.key === groupKeyD);
        if (!groupD) continue;
        if (!spend()) return false;
        const freed = withDay(base, d, null);
        const codeX = pickCode(x, u, g.window, freed, true);
        if (!codeX) continue;
        const dayD = ctx.daysOrder[d];
        const hoursOf = (id: string) => patternHours(ctx, patterns.get(id)!);
        const candidatesY = poolIds
          .filter((y) => y !== x && groupD.eligibleIds.has(y) && !worksOn(y, d))
          .map((y) => ({ y, h: hoursOf(y) }))
          .sort((a, b) => a.h - b.h || byId(a.y, b.y))
          .map((c) => c.y);
        for (const y of candidatesY) {
          if (!spend()) return false;
          const codeY = pickCode(y, d, groupD.window, patterns.get(y)!, true);
          if (!codeY) continue;
          // Apply atomically: X leaves d, Y takes d (same position), X takes u.
          const idx = assignments[dayD].findIndex((a) => a.employeeId === x);
          assignments[dayD].splice(idx, 1, { employeeId: y, shiftCode: codeY, groupKey: groupD.key });
          patterns.get(x)!.splice(d, 1, null);
          groupAt.delete(`${x}|${d}`);
          patterns.get(y)!.splice(d, 1, codeY);
          groupAt.set(`${y}|${d}`, groupD.key);
          place(x, u, codeX, g.key);
          changed = true;
          repairs.push({
            population: input.population, team: input.team, kind: "reallocate_for_gap", targetDay: dayU, reassignedDay: dayD,
            fromEmployeeId: x, toEmployeeId: y, filledByEmployeeId: x, reassignedShiftCode: codeY, targetShiftCode: codeX, cap,
            explanation: `${dayD} ${input.team} work reassigned from ${nameOf(x)} to ${nameOf(y)} (${codeY}) so ${nameOf(x)} could cover ${dayU}'s short ${input.team} need (${codeX}) within ${capPhrase(cap, ctx.caps)}.`,
          });
          return true;
        }
      }
    }
    return false;
  };

  // Sweeps until a sweep applies nothing (each applied move strictly lowers
  // the total shortfall, so this terminates) or the budget runs out.
  for (let progress = true; progress && !exhausted; ) {
    progress = false;
    for (let u = 0; u < n && !exhausted; u++) {
      for (const g of groupsByDay[ctx.daysOrder[u]] ?? []) {
        while (shortOf(ctx.daysOrder[u], g) > 0 && !exhausted) {
          if (!tryFill(u, g)) break;
          progress = true;
        }
      }
    }
  }

  return {
    assignmentsByDay: changed ? assignments : input.assignmentsByDay,
    repairs,
    search: { attemptsUsed: attempts, budget, budgetExhausted: exhausted },
  };
}

// ---------------------------------------------------------------------------
// FLEXIBLE POOL — Stage 6 demand gaps and OFF-run dead-ends
// ---------------------------------------------------------------------------

export interface FlexibleRepairInput {
  ctx: RepairLegalityContext;
  /** Flexible-pool employees only (isFlexibleGeneralPool) — the only people this pass may move. */
  employees: Employee[];
  demandByDay: Record<string, DailyDemand>;
  /** Stage 6's final (rest-enforced) demand-driven shifts, in pick order per day. */
  stage6ShiftsByDay: Record<string, GeneratedShiftAssignment[]>;
  /** Stage 6's hard-cap exclusions (population "flexible_pool"). */
  exclusions: HardCapExclusion[];
  maxConsecutiveOffDays: number;
  /** Simulates the Stage-6.5 top-up for one employee on a candidate Stage-6 result (roster-generation.ts's computeFlexibleEmployeeTopUp). */
  simulateTopUp: (employeeId: string, stage6ShiftsByDay: Record<string, GeneratedShiftAssignment[]>) => ReadonlyMap<string, string>;
  /**
   * Whether `role`'s demand on `day` is ALSO fully covered by its own
   * dedicated generation-driven team (Profiling/Mesure — generated
   * independently of Stage 6 from the same demand; true only when that team
   * reported no shortfall that day). Stage 6 counts Profiling/Mesure demand
   * too, so a flexible employee holding that skill shows up in Stage 6's
   * accounting as the "only" cover even when the dedicated team covers it
   * in full. Units of such a role are not treated as real gaps, and a move
   * may leave them to the dedicated team. Default: no role is.
   */
  dedicatedRoleCovered?: (day: string, role: string) => boolean;
  /** True when the plan runs with an enabled fatigue config (new assignments then carry fatigueReason: []). */
  fatigueActive?: boolean;
  rolesToConsider?: string[];
  budget?: number;
}

export interface FlexibleRepairResult {
  /** The repaired Stage-6 result (the SAME object as the input when no move was applied). */
  stage6ShiftsByDay: Record<string, GeneratedShiftAssignment[]>;
  repairs: HardCapRepair[];
  search: HardCapRepairSearch;
}

/**
 * Flexible-pool repair (see the module doc comment): first GAP repair on
 * Stage 6's still-uncovered hard (bucket, role) demand, then OFF-RUN repair.
 * Runs only when Stage 6 recorded at least one hard-cap exclusion (the
 * caller checks; this function also returns immediately without one).
 *
 * Coverage rule for every flexible move (replayStage6HardCoverage, per
 * (bucket, role) unit): a day's remaining demand may only go UP for a role
 * its dedicated team fully covers that day (dedicatedRoleCovered); any other
 * unit X covered before must still be covered after. Gap repair must also
 * strictly lower the target day's real remaining demand.
 *
 * OFF-run repair tries, per blocked employee X and in this order:
 *   (a) SHIFT OWN DAY — X moves one Stage-6 day d to one of their free days
 *       u (a code legal for X there), touching nobody else — exactly the
 *       "spread the same work days" fix; allowed only under the coverage
 *       rule above (i.e. what X leaves behind on d is covered by a
 *       dedicated team);
 *   (b) HAND-OFF — Y (OFF on d) takes X's day-d shift and the top-up refills
 *       X's week elsewhere.
 * Either way the top-up is re-simulated for everyone whose Stage-6 days
 * changed, and the move is kept only if X's OFF blocks then respect
 * max_consecutive_off_days, nobody else newly breaks it, and nobody loses a
 * rostered day.
 */
export function repairFlexiblePoolWeek(input: FlexibleRepairInput): FlexibleRepairResult {
  const { ctx, demandByDay } = input;
  const budget = input.budget ?? HARD_CAP_REPAIR_ATTEMPT_BUDGET;
  const roles = input.rolesToConsider ?? STAGE6_DEFAULT_ROLES;
  const n = ctx.daysOrder.length;
  const noop: FlexibleRepairResult = { stage6ShiftsByDay: input.stage6ShiftsByDay, repairs: [], search: { attemptsUsed: 0, budget, budgetExhausted: false } };
  const flexExclusions = input.exclusions.filter((x) => x.population === "flexible_pool");
  if (flexExclusions.length === 0) return noop;
  const dedicated = input.dedicatedRoleCovered ?? (() => false);

  const employeesById = new Map(input.employees.map((e) => [e.id, e]));
  const ids = input.employees.map((e) => e.id).sort(byId);
  const skillsById = new Map(input.employees.map((e) => [e.id, e.skills]));
  const nameOf = (id: string) => employeesById.get(id)?.name ?? id;

  let shifts: Record<string, GeneratedShiftAssignment[]> = input.stage6ShiftsByDay;
  let changed = false;
  let attempts = 0;
  let exhausted = false;
  const repairs: HardCapRepair[] = [];
  const spend = (): boolean => {
    if (attempts >= budget) {
      exhausted = true;
      return false;
    }
    attempts++;
    return true;
  };

  const patternOf = (id: string, s: Record<string, GeneratedShiftAssignment[]> = shifts): WeekPattern =>
    ctx.daysOrder.map((day) => (s[day] ?? []).find((g) => g.employeeId === id)?.shiftCode ?? null);
  type Replay = ReturnType<typeof replayStage6HardCoverage>;
  const replayOn = (j: number, list: { employeeId: string; shiftCode: string }[]): Replay => {
    const day = ctx.daysOrder[j];
    const demand = demandByDay[day];
    return demand ? replayStage6HardCoverage(demand, list, skillsById, flightDateFor(ctx.weekStart, day), roles) : { remaining: [], totalRemaining: 0, claimedRoles: [] };
  };
  /** Remaining units on day j that are REAL gaps (not covered by a dedicated team). */
  const realRemaining = (j: number, r: Replay): number => {
    const day = ctx.daysOrder[j];
    let total = 0;
    for (const m of r.remaining) for (const [role, v] of m) if (v > 0 && !dedicated(day, role)) total += v;
    return total;
  };
  /** The coverage rule: no (bucket, role) unit becomes MORE uncovered, unless its role is dedicated-covered that day. */
  const coverageOk = (j: number, before: Replay, after: Replay): boolean => {
    const day = ctx.daysOrder[j];
    for (let i = 0; i < before.remaining.length; i++) {
      for (const role of new Set([...before.remaining[i].keys(), ...(after.remaining[i]?.keys() ?? [])])) {
        if ((after.remaining[i]?.get(role) ?? 0) > (before.remaining[i].get(role) ?? 0) && !dedicated(day, role)) return false;
      }
    }
    return true;
  };
  /** Y must hold every role X's day-j shift was counted for, except roles a dedicated team covers that day (Check-in credit = default-placement eligibility, as in Stage 6). */
  const canStandIn = (y: Employee, coversRoles: string[], j: number) =>
    coversRoles.every((r) => dedicated(ctx.daysOrder[j], r) || (r === "Check-in" ? isEligibleForDefaultCheckinPlacement(y) : y.skills.includes(r)));
  const hoursById = () => new Map(ids.map((id) => [id, patternHours(ctx, patternOf(id))]));
  const extraKeys = (orig?: GeneratedShiftAssignment): Partial<GeneratedShiftAssignment> =>
    input.fatigueActive || orig?.fatigueReason !== undefined ? { fatigueReason: [] } : {};
  const withDays = (patch: Record<string, GeneratedShiftAssignment[]>): Record<string, GeneratedShiftAssignment[]> => ({ ...shifts, ...patch });
  /** Replacements Y for X's day-j shift, deterministic: rostered hours ascending, then id. */
  const standIns = (x: string, j: number, entry: GeneratedShiftAssignment, hours: Map<string, number>): string[] =>
    ids
      .filter((y) => y !== x && !patternOf(y)[j] && canStandIn(employeesById.get(y)!, entry.coversRoles, j))
      .sort((a, b) => (hours.get(a) ?? 0) - (hours.get(b) ?? 0) || byId(a, b));
  const catalogFor = (j: number) => {
    const date = flightDateFor(ctx.weekStart, ctx.daysOrder[j]);
    return Object.entries(shiftCatalogForDate(date))
      .map(([code, { entree, sortie }]) => ({ code, entree, sortie, dur: getShiftDurationHours(code, date) }))
      .filter((c) => c.sortie > c.entree);
  };
  const byGainThenShortest = <T extends { gain: number; dur: number; entree: string; code: string }>(a: T, b: T) =>
    b.gain - a.gain || a.dur - b.dur || (a.entree < b.entree ? -1 : a.entree > b.entree ? 1 : byId(a.code, b.code));

  // ---- Phase 1: GAP repair ------------------------------------------------
  for (let progress = true; progress && !exhausted; ) {
    progress = false;
    for (let u = 0; u < n && !exhausted; u++) {
      const dayU = ctx.daysOrder[u];
      let before = realRemaining(u, replayOn(u, shifts[dayU] ?? []));
      if (before === 0) continue;
      const blocked = [...new Set(flexExclusions.filter((x) => x.dayOfWeek === dayU).map((x) => x.employeeId))].filter((id) => employeesById.has(id)).sort(byId);
      const catalog = catalogFor(u);
      let movedThisDay = true;
      while (movedThisDay && before > 0 && !exhausted) {
        movedThisDay = false;
        const hours = hoursById();
        outer: for (const x of blocked) {
          const base = patternOf(x);
          if (base[u]) continue;
          // Codes X could legally (rest) work on u that would close some real gap, best first.
          const useful = catalog
            .filter((c) => restLegalAt(ctx, x, base, u, c.code))
            .map((c) => ({ ...c, gain: before - realRemaining(u, replayOn(u, [...(shifts[dayU] ?? []), { employeeId: x, shiftCode: c.code }])) }))
            .filter((c) => c.gain > 0)
            .sort(byGainThenShortest);
          if (useful.length === 0) continue;
          const cap = hardCapBreach(ctx, x, withDay(base, u, useful[0].code));
          if (cap === null) continue; // not cap-blocked — this pass only undoes hard-cap ordering artifacts
          for (let d = 0; d < n; d++) {
            if (d === u || !base[d]) continue;
            if (!spend()) break outer;
            const freed = withDay(base, d, null);
            const codeX = useful.find((c) => restLegalAt(ctx, x, freed, u, c.code) && hardCapBreach(ctx, x, withDay(freed, u, c.code)) === null);
            if (!codeX) continue;
            const dayD = ctx.daysOrder[d];
            const entry = (shifts[dayD] ?? []).find((g) => g.employeeId === x)!;
            const replayDBefore = replayOn(d, shifts[dayD] ?? []);
            for (const y of standIns(x, d, entry, hours)) {
              if (!spend()) break outer;
              const yPattern = patternOf(y);
              if (!restLegalAt(ctx, y, yPattern, d, entry.shiftCode)) continue;
              if (hardCapBreach(ctx, y, withDay(yPattern, d, entry.shiftCode)) !== null) continue;
              const newD = (shifts[dayD] ?? []).map((g) => (g.employeeId === x ? { ...g, employeeId: y } : g));
              if (!coverageOk(d, replayDBefore, replayOn(d, newD))) continue; // Y must cover what X covered
              const replayU = replayOn(u, [...(shifts[dayU] ?? []), { employeeId: x, shiftCode: codeX.code }]);
              const afterU = realRemaining(u, replayU);
              if (afterU >= before) continue;
              const explanation = `${dayD} reassigned from ${nameOf(x)} to ${nameOf(y)} (${entry.shiftCode}) so ${nameOf(x)} could cover ${dayU}'s otherwise-uncovered demand (${codeX.code}) within ${capPhrase(cap, ctx.caps)}.`;
              const yEntry: GeneratedShiftAssignment = { ...entry, employeeId: y, hardCapRepairReason: explanation };
              const xEntry: GeneratedShiftAssignment = {
                employeeId: x, dayOfWeek: dayU, shiftCode: codeX.code, coversRoles: replayU.claimedRoles[replayU.claimedRoles.length - 1], ...extraKeys(entry), hardCapRepairReason: explanation,
              };
              shifts = withDays({ [dayD]: (shifts[dayD] ?? []).map((g) => (g.employeeId === x ? yEntry : g)), [dayU]: [...(shifts[dayU] ?? []), xEntry] });
              changed = true;
              repairs.push({
                population: "flexible_pool", team: "General T1 Pool", kind: "reallocate_for_gap", targetDay: dayU, reassignedDay: dayD, fromEmployeeId: x, toEmployeeId: y,
                filledByEmployeeId: x, reassignedShiftCode: entry.shiftCode, targetShiftCode: codeX.code, cap, explanation,
              });
              before = afterU;
              movedThisDay = true;
              progress = true;
              break outer;
            }
          }
        }
      }
    }
  }

  // ---- Phase 2: OFF-RUN repair ---------------------------------------------
  const topUpCache = new Map<string, ReadonlyMap<string, string>>();
  const fullPattern = (id: string, s: Record<string, GeneratedShiftAssignment[]>, useCache: boolean): WeekPattern => {
    let adds = useCache ? topUpCache.get(id) : undefined;
    if (!adds) {
      adds = input.simulateTopUp(id, s);
      if (useCache) topUpCache.set(id, adds);
    }
    return patternOf(id, s).map((code, j) => code ?? adds!.get(ctx.daysOrder[j]) ?? null);
  };
  const offRun = (p: WeekPattern) => maxConsecutiveOffCyclic(p.map((c) => ({ status: c ? ("working" as const) : ("off" as const) })));
  const workDays = (p: WeekPattern) => p.filter(Boolean).length;
  const offPhrase = (runBefore: number) => `avoiding a ${runBefore}-day OFF block (max ${input.maxConsecutiveOffDays} consecutive OFF days)`;

  const candidatesX = [...new Set(flexExclusions.map((x) => x.employeeId))].filter((id) => employeesById.has(id)).sort(byId);
  for (const x of candidatesX) {
    if (exhausted) break;
    const xFull = fullPattern(x, shifts, true);
    const runBefore = offRun(xFull);
    if (runBefore <= input.maxConsecutiveOffDays) continue;
    const base = patternOf(x);
    const cap = flexExclusions.find((e) => e.employeeId === x)?.reason ?? null;
    const xOk = (after: WeekPattern) => offRun(after) <= input.maxConsecutiveOffDays && workDays(after) >= workDays(xFull) && hardCapBreach(ctx, x, after) === null;
    let fixed = false;

    // (a) SHIFT OWN DAY: d -> u, nobody else touched.
    for (let d = 0; d < n && !fixed && !exhausted; d++) {
      if (!base[d]) continue;
      const dayD = ctx.daysOrder[d];
      const entry = (shifts[dayD] ?? []).find((g) => g.employeeId === x)!;
      const newD = (shifts[dayD] ?? []).filter((g) => g.employeeId !== x);
      if (!coverageOk(d, replayOn(d, shifts[dayD] ?? []), replayOn(d, newD))) continue; // what X leaves on d must be dedicated-covered
      const freed = withDay(base, d, null);
      for (let u = 0; u < n && !fixed; u++) {
        if (u === d || base[u]) continue;
        if (!spend()) break;
        const dayU = ctx.daysOrder[u];
        const beforeU = replayOn(u, shifts[dayU] ?? []);
        const code = catalogFor(u)
          .filter((c) => restLegalAt(ctx, x, freed, u, c.code) && hardCapBreach(ctx, x, withDay(freed, u, c.code)) === null)
          .map((c) => ({ ...c, gain: beforeU.totalRemaining - replayOn(u, [...(shifts[dayU] ?? []), { employeeId: x, shiftCode: c.code }]).totalRemaining }))
          .sort(byGainThenShortest)[0];
        if (!code) continue;
        const replayU = replayOn(u, [...(shifts[dayU] ?? []), { employeeId: x, shiftCode: code.code }]);
        const candidate = withDays({ [dayD]: newD, [dayU]: [...(shifts[dayU] ?? []), { employeeId: x, dayOfWeek: dayU, shiftCode: code.code, coversRoles: [] }] });
        const xAfter = fullPattern(x, candidate, false);
        if (!xOk(xAfter)) continue;
        const explanation = `${nameOf(x)}'s ${dayD} work moved to ${dayU} (${code.code}) so their week stays within ${capPhrase(cap, ctx.caps)} while ${offPhrase(runBefore)}; ${dayD}'s ${entry.coversRoles.join("/") || "demand"} coverage there is held by the dedicated team.`;
        const xEntry: GeneratedShiftAssignment = {
          employeeId: x, dayOfWeek: dayU, shiftCode: code.code, coversRoles: replayU.claimedRoles[replayU.claimedRoles.length - 1], ...extraKeys(entry), hardCapRepairReason: explanation,
        };
        shifts = withDays({ [dayD]: newD, [dayU]: [...(shifts[dayU] ?? []), xEntry] });
        topUpCache.delete(x);
        changed = true;
        repairs.push({
          population: "flexible_pool", team: "General T1 Pool", kind: "shift_own_day_for_off_run", targetDay: dayU, reassignedDay: dayD, fromEmployeeId: x, toEmployeeId: null,
          filledByEmployeeId: x, reassignedShiftCode: entry.shiftCode, targetShiftCode: code.code, cap, explanation,
        });
        fixed = true;
      }
    }

    // (b) HAND-OFF: Y takes X's day d; the top-up refills X elsewhere.
    const hours = hoursById();
    for (let d = 0; d < n && !fixed && !exhausted; d++) {
      if (!base[d]) continue;
      const dayD = ctx.daysOrder[d];
      const entry = (shifts[dayD] ?? []).find((g) => g.employeeId === x)!;
      const replayDBefore = replayOn(d, shifts[dayD] ?? []);
      for (const y of standIns(x, d, entry, hours)) {
        if (!spend()) break;
        const yPattern = patternOf(y);
        if (!restLegalAt(ctx, y, yPattern, d, entry.shiftCode)) continue;
        if (hardCapBreach(ctx, y, withDay(yPattern, d, entry.shiftCode)) !== null) continue;
        const newD = (shifts[dayD] ?? []).map((g) => (g.employeeId === x ? { ...g, employeeId: y } : g));
        if (!coverageOk(d, replayDBefore, replayOn(d, newD))) continue;
        const candidate = withDays({ [dayD]: newD });
        const xAfter = fullPattern(x, candidate, false);
        if (!xOk(xAfter)) continue;
        const yBefore = fullPattern(y, shifts, true);
        const yAfter = fullPattern(y, candidate, false);
        if (offRun(yAfter) > Math.max(input.maxConsecutiveOffDays, offRun(yBefore)) || workDays(yAfter) < workDays(yBefore) || hardCapBreach(ctx, y, yAfter) !== null) continue;
        const gained = ctx.daysOrder.filter((_, j) => xAfter[j] && !xFull[j]);
        const explanation = `${dayD} reassigned from ${nameOf(x)} to ${nameOf(y)} (${entry.shiftCode}) so ${nameOf(x)} could work ${gained.length > 0 ? gained.join(", ") : "another day"} instead within ${capPhrase(cap, ctx.caps)}, ${offPhrase(runBefore)}.`;
        shifts = withDays({ [dayD]: newD.map((g) => (g.employeeId === y ? { ...entry, employeeId: y, hardCapRepairReason: explanation } : g)) });
        topUpCache.delete(x);
        topUpCache.delete(y);
        changed = true;
        repairs.push({
          population: "flexible_pool", team: "General T1 Pool", kind: "reallocate_for_off_run", targetDay: dayD, reassignedDay: dayD, fromEmployeeId: x, toEmployeeId: y,
          filledByEmployeeId: y, reassignedShiftCode: entry.shiftCode, targetShiftCode: null, cap, explanation,
        });
        fixed = true;
        break;
      }
    }
  }

  return { stage6ShiftsByDay: changed ? shifts : input.stage6ShiftsByDay, repairs, search: { attemptsUsed: attempts, budget, budgetExhausted: exhausted } };
}
