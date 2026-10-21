import { Employee, Config } from "../types";
import { flightDateFor } from "../flight-date";
import { getShiftTimesAs, shiftCatalogForDate } from "../shift-templates";
import { restHoursBetween } from "../roster-generation";
import { usesFixedCycleRotation } from "../teams";
import { isGenerationDrivenPopulation } from "./workforce-pools";
import { wouldExceedShiftDurationCap, wouldExceedConsecutiveNightShiftCap, nextConsecutiveNightShiftStreak, isNightShift } from "./hard-work-caps";
import { GeneratedShiftAssignment, PriorDayShiftMap } from "./shift-generation";

/**
 * HARD-RULE GATE (2026-10-21) — "hard rules are obeyed BEFORE the plan is
 * persisted; only soft rules are merely flagged."
 *
 * Before this gate, only the flexible General T1 pool had its hard OFF /
 * cap rules enforced while its roster was being built; the foreign-company
 * and Profiling/Mesure generators followed airline operating days or demand
 * and the plan validator only reported the breach afterwards. This pass
 * runs over EVERY generation-driven employee's generated week, after all
 * populations have produced their shifts and before the rest gate, duty
 * generation and persistence, and repairs the roster itself:
 *
 *   1. max continuous shift duration  -> an offending shift is removed
 *   2. max consecutive night shifts   -> the offending later night is removed
 *   3. minimum OFF days + ONE consecutive OFF block (+ max consecutive OFF)
 *      -> the cheapest cyclic OFF window is chosen; working days inside it
 *      are removed (a real coverage gap then surfaces as unfilled_duty —
 *      never a silent rule break) and OFF days outside it become working
 *      days (idle capacity, no duty required) using a rest- and cap-legal
 *      shift code the employee already works that week.
 *
 * Priority when hard rules cannot all hold: the OFF structure is repaired
 * only with legal moves; if no legal window exists the employee is returned
 * in `unresolved` and the normal validator still flags the breach.
 *
 * NOT covered here (still detection-only, see docs/known-limitations):
 * weekly/monthly paid-hours limits — meeting them can force more OFF days
 * than the OFF rules allow, so which hard rule wins is a policy decision.
 */

export interface HardRuleAction {
  employeeId: string;
  dayOfWeek: string;
  action: "removed" | "added";
  shiftCode: string;
  rule: "max_continuous_shift_hours" | "max_consecutive_night_shifts" | "off_block";
}

export interface HardRuleGateResult {
  shiftsByDay: Record<string, GeneratedShiftAssignment[]>;
  actions: HardRuleAction[];
  unresolved: { employeeId: string; rule: "off_block"; detail: string }[];
}

const REMOVAL_COST = 10; // coverage loss is far worse than an extra idle roster day
const ADDITION_COST = 1;

function restOk(prev: string | undefined, prevDate: string, next: string | undefined, nextDate: string, minRest: number): boolean {
  if (!prev || !next) return true;
  const p = getShiftTimesAs(prev, prevDate);
  const n = getShiftTimesAs(next, nextDate);
  return restHoursBetween(p.shift_start, p.shift_end, n.shift_start) >= minRest;
}

export function enforceHardRulesOnGeneratedRoster(input: {
  daysOrder: string[];
  weekStart: string;
  employees: Employee[];
  shiftsByDay: Record<string, GeneratedShiftAssignment[]>;
  config: Config;
  /** Each employee's real shift on the day before this planning week (Sunday of the prior plan), if known. */
  priorBoundary?: PriorDayShiftMap;
  /** Consecutive work days each employee had entering this week (0 / absent = none known). */
  incomingWorkStreak?: ReadonlyMap<string, number>;
}): HardRuleGateResult {
  const { daysOrder, weekStart, employees, config } = input;
  const actions: HardRuleAction[] = [];
  const unresolved: HardRuleGateResult["unresolved"] = [];
  const dateOf = (day: string) => flightDateFor(weekStart, day);

  // employeeId -> day -> shift code (working only)
  const worked = new Map<string, Map<string, string>>();
  for (const day of daysOrder) {
    for (const g of input.shiftsByDay[day] ?? []) {
      if (!worked.has(g.employeeId)) worked.set(g.employeeId, new Map());
      worked.get(g.employeeId)!.set(day, g.shiftCode);
    }
  }
  const added = new Map<string, Map<string, GeneratedShiftAssignment>>();

  const durationCap = config.max_continuous_shift_hours ?? null;
  const nightCap = config.max_consecutive_night_shifts ?? null;

  for (const employee of employees) {
    if (!employee.active || usesFixedCycleRotation(employee.assignment) || !isGenerationDrivenPopulation(employee)) continue;
    const days = worked.get(employee.id) ?? new Map<string, string>();
    worked.set(employee.id, days);

    // 1 + 2: per-shift caps (removal only).
    let nightStreak = 0;
    for (const day of daysOrder) {
      const code = days.get(day);
      if (!code) {
        nightStreak = nextConsecutiveNightShiftStreak(nightStreak, false);
        continue;
      }
      if (wouldExceedShiftDurationCap(code, dateOf(day), durationCap)) {
        days.delete(day);
        actions.push({ employeeId: employee.id, dayOfWeek: day, action: "removed", shiftCode: code, rule: "max_continuous_shift_hours" });
        nightStreak = nextConsecutiveNightShiftStreak(nightStreak, false);
        continue;
      }
      const night = isNightShift(code, dateOf(day));
      if (wouldExceedConsecutiveNightShiftCap(nightStreak, night, nightCap)) {
        days.delete(day);
        actions.push({ employeeId: employee.id, dayOfWeek: day, action: "removed", shiftCode: code, rule: "max_consecutive_night_shifts" });
        nightStreak = nextConsecutiveNightShiftStreak(nightStreak, false);
        continue;
      }
      nightStreak = nextConsecutiveNightShiftStreak(nightStreak, night);
    }

    // 3: OFF structure (full planning week only, like the validator).
    if (daysOrder.length !== 7) continue;
    const n = daysOrder.length;
    const offDays = daysOrder.filter((d) => !days.has(d));
    const minOff = config.minimum_off_days_per_planning_week;
    const wantBlock = config.normal_off_days_consecutive;
    const isOneCyclicBlock = (): boolean => {
      const off = daysOrder.map((d) => !days.has(d));
      if (off.every(Boolean) || !off.some(Boolean)) return true;
      let runs = 0;
      for (let i = 0; i < n; i++) if (off[i] && !off[(i + n - 1) % n]) runs++;
      return runs === 1;
    };
    if (offDays.length >= minOff && (!wantBlock || isOneCyclicBlock())) continue;

    // Window length: the soft target, clamped into the hard bounds.
    const length = Math.min(config.max_consecutive_off_days, Math.max(minOff, config.normal_weekly_off_days, 1));
    if (!wantBlock) {
      // Only the floor applies: remove working days until it holds.
      for (let i = n - 1; i >= 0 && daysOrder.filter((d) => !days.has(d)).length < minOff; i--) {
        const code = days.get(daysOrder[i]);
        if (code) {
          days.delete(daysOrder[i]);
          actions.push({ employeeId: employee.id, dayOfWeek: daysOrder[i], action: "removed", shiftCode: code, rule: "off_block" });
        }
      }
      continue;
    }

    const usualCodes = Array.from(new Set([...days.values(), employee.shift_code].filter((c): c is string => Boolean(c))));
    let best: { start: number; cost: number; adds: Map<string, string>; removes: string[] } | null = null;
    for (let start = 0; start < n; start++) {
      const windowDays = Array.from({ length }, (_, k) => daysOrder[(start + k) % n]);
      const windowSet = new Set(windowDays);
      const removes = windowDays.filter((d) => days.has(d));
      const toAdd = daysOrder.filter((d) => !windowSet.has(d) && !days.has(d));
      // Final week state if this window were applied.
      const finalCode = (d: string, adds: Map<string, string>) => (windowSet.has(d) ? undefined : (days.get(d) ?? adds.get(d)));
      const adds = new Map<string, string>();
      let feasible = true;
      for (const d of toAdd) {
        const idx = daysOrder.indexOf(d);
        const prevDay = daysOrder[(idx + n - 1) % n];
        const nextDay = daysOrder[(idx + 1) % n];
        // The employee's own codes first; then any catalog code, because a
        // single code (e.g. MT02, 03:45-15:00) can never be worked two days in
        // a row under the 15h rest rule, yet an idle roster day still has to
        // exist for the OFF block to be possible.
        const candidates = Array.from(new Set([...usualCodes, ...Object.keys(shiftCatalogForDate(dateOf(d)))]));
        const pick = candidates.find((code) => {
          if (wouldExceedShiftDurationCap(code, dateOf(d), durationCap)) return false;
          // Neighbours are CYCLIC (Sunday -> Monday), the same repeat-pattern rest check the validator applies.
          const prevOk = restOk(finalCode(prevDay, adds), dateOf(prevDay), code, dateOf(d), config.minimum_rest_hours);
          const nextOk = restOk(code, dateOf(d), finalCode(nextDay, adds), dateOf(nextDay), config.minimum_rest_hours);
          if (!prevOk || !nextOk) return false;
          if (idx === 0) {
            // Real boundary: the prior plan's actual last-day shift, when known.
            const prior = input.priorBoundary?.get(employee.id);
            if (prior) {
              const t = getShiftTimesAs(code, dateOf(d));
              if (restHoursBetween(prior.shift_start, prior.shift_end, t.shift_start) < config.minimum_rest_hours) return false;
            }
          }
          return true;
        });
        if (!pick) {
          feasible = false;
          break;
        }
        adds.set(d, pick);
      }
      if (!feasible) continue;
      // Adding idle days must never create a run above the hard consecutive-work-day cap.
      let run = input.incomingWorkStreak?.get(employee.id) ?? 0;
      for (const d of daysOrder) {
        const works = !windowSet.has(d) && (days.has(d) || adds.has(d));
        run = works ? run + 1 : 0;
        if (run > config.max_consecutive_work_days) feasible = false;
      }
      if (!feasible) continue;
      const cost = removes.length * REMOVAL_COST + adds.size * ADDITION_COST;
      if (!best || cost < best.cost) best = { start, cost, adds, removes };
    }

    if (!best) {
      unresolved.push({ employeeId: employee.id, rule: "off_block", detail: "no rest- and cap-legal way to form one consecutive OFF block" });
      continue;
    }
    for (const d of best.removes) {
      actions.push({ employeeId: employee.id, dayOfWeek: d, action: "removed", shiftCode: days.get(d)!, rule: "off_block" });
      days.delete(d);
    }
    for (const [d, code] of best.adds) {
      days.set(d, code);
      actions.push({ employeeId: employee.id, dayOfWeek: d, action: "added", shiftCode: code, rule: "off_block" });
      if (!added.has(employee.id)) added.set(employee.id, new Map());
      added.get(employee.id)!.set(d, { employeeId: employee.id, dayOfWeek: d, shiftCode: code, coversRoles: [] });
    }
  }

  // Rebuild: keep original assignments that survive unchanged, add new ones.
  const shiftsByDay: Record<string, GeneratedShiftAssignment[]> = {};
  for (const day of daysOrder) {
    const kept = (input.shiftsByDay[day] ?? []).filter((g) => {
      const w = worked.get(g.employeeId);
      return !w || w.get(day) === g.shiftCode;
    });
    const extra: GeneratedShiftAssignment[] = [];
    for (const [, byDay] of added) {
      const a = byDay.get(day);
      if (a) extra.push(a);
    }
    shiftsByDay[day] = [...kept, ...extra];
  }
  return { shiftsByDay, actions, unresolved };
}
