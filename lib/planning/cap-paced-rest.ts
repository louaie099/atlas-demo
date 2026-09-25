import { HardWorkCaps } from "./hard-work-caps";

/**
 * CAP-PACED REST PLANNING for the specialized teams (2026-09-25, fix for the
 * "whole team hits the hard cap on the same day" lockstep — see
 * docs/known-limitations/roster-planning-vs-duty-allocation.md, section
 * "2026-09-25 — Specialized-team hard-cap lockstep").
 *
 * THE BUG THIS EXISTS FOR. specialized-team-generation.ts's
 * sortByLeastUsedFirst (the 2026-09-21 fairness fix) re-sorts a team by
 * ascending hours-so-far every day and the day's demand takes the first N
 * legal members. That spreads work evenly — so evenly that, once the hard
 * weekly-hours cap (hard-work-caps.ts) exists and a week's demand exceeds
 * what the team can legally work, every member's hours climb in near-
 * lockstep and the WHOLE team crosses the cap on (almost) the same day.
 * Measured on the real 2026-10-05 stress week: Profiling+Mesure 23/22/18/
 * 22/11 of 24 working Monday-Friday, then 0/24 Saturday AND Sunday. The
 * phase-2 repair pass (hard-cap-repair.ts) cannot fix that: it hands a day
 * to an OFF, under-cap colleague, and no such colleague exists when
 * everyone is capped at once.
 *
 * Crucially, no ORDERING change alone can fix it: on that week Mesure needs
 * 12 distinct people every day from a 12-person team, so any order still
 * assigns everyone Monday-Thursday. When real demand exceeds the team's
 * legal weekly capacity, somebody has to REST on a day that has demand, so
 * that capacity is still there later in the week. This module decides who,
 * deterministically and up front.
 *
 * THE MECHANISM (only when the team is genuinely capacity-constrained):
 *
 *   1. Per member, an estimated capacity in work days this window: the most
 *      demand days that fit under the hard weekly-hours cap at each day's
 *      estimated covering-shift hours (cheapest days first), and under the
 *      consecutive-work-day cap from the member's real incoming streak.
 *   2. `active` iff the team's total capacity < the week's demand in
 *      person-days (each day's need capped at the team size). Otherwise the
 *      plan is inert and the caller keeps its exact prior behaviour
 *      (byte-identical output) — the greedy is fine when there is enough
 *      capacity to go round.
 *   3. The capacity is spread over the days in proportion to each day's
 *      demand (largest-remainder rounding, ties to the earlier day): every
 *      day gets a fair share of the shortfall, instead of the first days
 *      getting full coverage and the last getting none.
 *   4. Members are placed on days one day at a time, most-constrained first
 *      (least slack = remaining demand days minus remaining capacity), then
 *      anyone about to exceed the max-consecutive-OFF preference, then
 *      fewer planned hours, then team order. That rotation staggers who
 *      rests when (each placement lowers that member's remaining capacity,
 *      so the next day favours others), and gives each member a PREFERRED
 *      set of work days; the rest are their preferred rest days.
 *
 * WHAT THE CALLER DOES WITH IT. The plan only decides ORDER and who is
 * held back to rest. It is never an eligibility rule: every candidate
 * still passes the unchanged 15h rest / hard-cap / qualification filter in
 * selectCompatibleShiftCodes. A member on a preferred rest day is "drawn
 * in" anyway when that cannot cost one of their own later preferred work
 * days (planAllowsDrawIn) — this absorbs estimate error and planned workers
 * who turn out not to be rest-legal. Among members equally placed by the
 * plan, the 2026-09-21 least-used-hours ordering is still the tie-break, so
 * nobody is permanently favoured.
 *
 * Deterministic: pure function of its inputs, no randomness, stable ties.
 */

const HOURS_EPSILON = 1e-9;

export interface CapPacedRestPlanInput {
  /** The (sub-)team's members, in its stable team order (the final tie-break). */
  memberIds: readonly string[];
  daysOrder: readonly string[];
  /** Distinct people each day's real demand needs from this (sub-)team; 0 = no demand that day. */
  demandByDay: readonly number[];
  /** Estimated hours of one covering shift on each day (ignored where demand is 0). */
  estimatedShiftHoursByDay: readonly number[];
  caps: HardWorkCaps;
  /** Each member's consecutive-work-day streak entering the window (missing = 0). */
  incomingStreakByEmployee: ReadonlyMap<string, number>;
  /** Soft shaping: prefer to place a member whose planned OFF run has reached this length. Omitted = no shaping. */
  maxConsecutiveOffDays?: number;
  /**
   * Per-day coverage ratio a sibling role sub-team already planned (e.g. the
   * ACE plan when planning Leaders): only a tie-break for where this plan's
   * spare units go, so the two sub-teams' shortfalls do not stack on one day.
   */
  siblingCoverageByDay?: readonly number[];
}

export interface CapPacedRestPlan {
  /** False = the team has enough capacity for the week's demand; the caller must behave exactly as before. */
  active: boolean;
  /** Σ per-member estimated capacity (work days) this window. */
  capacityDays: number;
  /** Σ over days of min(demand, team size): the person-days real demand asks for. */
  demandDays: number;
  capacityDaysByMember: Map<string, number>;
  /** How many members the plan puts to work each day (index-aligned with daysOrder). Empty when inactive. */
  plannedWorkersByDay: number[];
  /** Each member's preferred work days (day names). Empty when inactive. */
  preferredWorkDays: Map<string, Set<string>>;
  // Kept for planAllowsDrawIn.
  daysOrder: readonly string[];
  estimatedShiftHoursByDay: readonly number[];
  caps: HardWorkCaps;
}

/**
 * Splits `total` over `weights` proportionally (largest-remainder rounding),
 * never giving an index more than `limits[i]` (defaults to its weight).
 * Deterministic. Leftover units among positions with EQUAL remainders are
 * spread evenly across those positions (listed starting at `rotation`), not
 * handed to the earliest ones — otherwise every tie (and two sub-teams'
 * ties compounding) would systematically push the shortfall onto the same
 * last days, a small echo of the very bias this module removes. With
 * `priorLoad` (e.g. the coverage a sibling role sub-team already planned per
 * day), tied positions with LOWER prior load are served first, so two
 * sub-teams' spare units land on different days instead of compounding.
 */
export function allocateProportionally(total: number, weights: readonly number[], limits: readonly number[] = weights, rotation = 0, priorLoad?: readonly number[]): number[] {
  const n = weights.length;
  const sumW = weights.reduce((a, b) => a + b, 0);
  const out = weights.map(() => 0);
  if (total <= 0 || sumW <= 0 || n === 0) return out;
  const t = Math.min(total, limits.reduce((a, b) => a + b, 0));
  const raw = weights.map((w) => (t * w) / sumW);
  for (let i = 0; i < n; i++) out[i] = Math.min(limits[i], Math.floor(raw[i] + HOURS_EPSILON));
  let left = t - out.reduce((a, b) => a + b, 0);
  const frac = raw.map((r) => r - Math.floor(r + HOURS_EPSILON));
  while (left > 0) {
    const open = out.map((v, i) => i).filter((i) => out[i] < limits[i]);
    if (open.length === 0) break;
    // Highest remaining remainder first; the tie group in rotated order.
    const best = Math.max(...open.map((i) => frac[i]));
    const group = open.filter((i) => Math.abs(frac[i] - best) < 1e-9).sort((a, b) => ((a - rotation + n) % n) - ((b - rotation + n) % n));
    // Within the tie group: lowest prior load first; among equal loads, evenly spaced.
    const loads = [...new Set(group.map((i) => priorLoad?.[i] ?? 0))].sort((a, b) => a - b);
    for (const load of loads) {
      if (left <= 0) break;
      const level = group.filter((i) => Math.abs((priorLoad?.[i] ?? 0) - load) < 1e-9);
      const k = Math.min(left, level.length);
      for (let j = 0; j < k; j++) {
        const i = level[Math.floor(((j + 0.5) * level.length) / k)];
        out[i]++;
        frac[i] = -1; // a position gets at most one leftover unit per round
      }
      left -= k;
    }
    if (open.every((i) => frac[i] < 0)) for (const i of open) frac[i] = 0;
  }
  return out;
}

/** Estimated work-day capacity of one member: min(hours-cap days at cheapest-first, consecutive-cap days). */
function memberCapacityDays(demandDayIdx: number[], hours: readonly number[], caps: HardWorkCaps, incomingStreak: number, n: number, demand: readonly number[]): number {
  const costs = demandDayIdx.map((i) => hours[i]).sort((a, b) => a - b);
  let sum = 0;
  let byHours = 0;
  for (const c of costs) {
    if (sum + c > caps.hardWeeklyHoursCap + HOURS_EPSILON) break;
    sum += c;
    byHours++;
  }
  let streak = incomingStreak;
  let byStreak = 0;
  for (let i = 0; i < n; i++) {
    if (demand[i] > 0 && streak + 1 <= caps.maxConsecutiveWorkDays) {
      streak++;
      byStreak++;
    } else {
      streak = 0;
    }
  }
  return Math.min(byHours, byStreak);
}

export function planCapPacedRestDays(input: CapPacedRestPlanInput): CapPacedRestPlan {
  const { memberIds, daysOrder, demandByDay, estimatedShiftHoursByDay, caps, incomingStreakByEmployee, maxConsecutiveOffDays } = input;
  const n = daysOrder.length;
  const teamSize = memberIds.length;
  const cappedDemand = demandByDay.map((d) => Math.max(0, Math.min(d, teamSize)));
  const demandDays = cappedDemand.reduce((a, b) => a + b, 0);
  const demandDayIdx = cappedDemand.map((d, i) => (d > 0 ? i : -1)).filter((i) => i >= 0);
  const capacityDaysByMember = new Map<string, number>();
  for (const id of memberIds) {
    capacityDaysByMember.set(id, memberCapacityDays(demandDayIdx, estimatedShiftHoursByDay, caps, incomingStreakByEmployee.get(id) ?? 0, n, cappedDemand));
  }
  const capacityDays = [...capacityDaysByMember.values()].reduce((a, b) => a + b, 0);
  const base = { capacityDays, demandDays, capacityDaysByMember, daysOrder, estimatedShiftHoursByDay, caps };
  if (teamSize === 0 || capacityDays >= demandDays) {
    return { ...base, active: false, plannedWorkersByDay: [], preferredWorkDays: new Map() };
  }

  const targetByDay = allocateProportionally(capacityDays, cappedDemand, cappedDemand, 0, input.siblingCoverageByDay);
  const quota = new Map(capacityDaysByMember);
  const streak = new Map(memberIds.map((id) => [id, incomingStreakByEmployee.get(id) ?? 0]));
  const plannedHours = new Map(memberIds.map((id) => [id, 0]));
  const offRun = new Map(memberIds.map((id) => [id, 0]));
  const preferredWorkDays = new Map(memberIds.map((id) => [id, new Set<string>()]));
  const plannedWorkersByDay: number[] = [];
  const index = new Map(memberIds.map((id, k) => [id, k]));

  for (let i = 0; i < n; i++) {
    const want = targetByDay[i];
    const hours = estimatedShiftHoursByDay[i];
    const futureDemandDays = targetByDay.slice(i).filter((w) => w > 0).length;
    const chosen = new Set<string>();
    if (want > 0) {
      const candidates = memberIds
        .filter((id) => quota.get(id)! > 0 && streak.get(id)! + 1 <= caps.maxConsecutiveWorkDays && plannedHours.get(id)! + hours <= caps.hardWeeklyHoursCap + HOURS_EPSILON)
        .map((id) => ({
          id,
          slack: futureDemandDays - quota.get(id)!,
          offDue: maxConsecutiveOffDays !== undefined && offRun.get(id)! >= maxConsecutiveOffDays ? 0 : 1,
          hours: plannedHours.get(id)!,
          k: index.get(id)!,
        }))
        .sort((a, b) => a.slack - b.slack || a.offDue - b.offDue || a.hours - b.hours || a.k - b.k);
      for (const c of candidates.slice(0, want)) chosen.add(c.id);
    }
    for (const id of memberIds) {
      if (chosen.has(id)) {
        quota.set(id, quota.get(id)! - 1);
        streak.set(id, streak.get(id)! + 1);
        plannedHours.set(id, plannedHours.get(id)! + hours);
        offRun.set(id, 0);
        preferredWorkDays.get(id)!.add(daysOrder[i]);
      } else {
        streak.set(id, 0);
        offRun.set(id, offRun.get(id)! + 1);
      }
    }
    plannedWorkersByDay.push(chosen.size);
  }
  return { ...base, active: true, plannedWorkersByDay, preferredWorkDays };
}

/**
 * May `employeeId`, on day `dayIndex` that is NOT one of their preferred
 * work days, still be offered today's work? Only when it cannot cost one of
 * their own later preferred work days: their real hours so far + today's
 * estimated shift + every later preferred day's estimate still fit under
 * the hard weekly-hours cap, and working today would not join a planned run
 * past the consecutive-work-day cap. This is a soft ordering gate — the
 * hard filters still decide actual legality.
 */
export function planAllowsDrawIn(plan: CapPacedRestPlan, employeeId: string, dayIndex: number, hoursSoFar: number, streakEnteringDay: number): boolean {
  const preferred = plan.preferredWorkDays.get(employeeId);
  if (!preferred) return true;
  let committed = hoursSoFar + plan.estimatedShiftHoursByDay[dayIndex];
  for (let j = dayIndex + 1; j < plan.daysOrder.length; j++) if (preferred.has(plan.daysOrder[j])) committed += plan.estimatedShiftHoursByDay[j];
  if (committed > plan.caps.hardWeeklyHoursCap + HOURS_EPSILON) return false;
  let run = streakEnteringDay + 1;
  for (let j = dayIndex + 1; j < plan.daysOrder.length && preferred.has(plan.daysOrder[j]); j++) run++;
  return run <= plan.caps.maxConsecutiveWorkDays;
}
