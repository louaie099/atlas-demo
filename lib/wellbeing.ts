import { AgentScheduleEntry } from "./types";

/**
 * WORKLOAD & WELLBEING metrics (2026-10-21) — computed from the SAME
 * AgentScheduleEntry[] Monthly Planning's Agent Schedule renders (one plan,
 * one source of truth), never from a separate model. Everything here is
 * derived from each day's REAL effective shift (AgentDayEntry.shiftStart/
 * shiftEnd), within one planning week. Cross-week continuity (rest between
 * Sunday and the next Monday, streaks that started last week) is NOT
 * visible from one week's schedule and is deliberately not guessed at.
 *
 * LOAD BALANCE INDEX — a transparent heuristic, not a regulatory metric:
 *   burden  = scheduled hours + NIGHT_WEIGHT × night shifts + WEEKEND_WEIGHT × weekend days worked
 *   index   = clamp(100 − 100 × stdDev(burden) / mean(burden), 0, 100)
 * 100 = everyone carries the same burden; lower = the burden is unevenly
 * shared. Only agents who work at least one day this week are compared.
 */

export const NIGHT_WEIGHT_HOURS = 4;
export const WEEKEND_WEIGHT_HOURS = 2;
const DAY = 1440;
const DAY_INDEX: Record<string, number> = { Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3, Friday: 4, Saturday: 5, Sunday: 6 };

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export interface AgentWellbeing {
  employeeId: string;
  name: string;
  team: string;
  workedDays: number;
  hours: number;
  nights: number;
  weekendDays: number;
  longestStreak: number;
  /** Shortest rest between two consecutive working days this week, in hours; null when there is no such pair. */
  minRestHours: number | null;
  /** Number of consecutive-day pairs below the required minimum rest. */
  restBreaches: number;
  burden: number;
}

export interface WellbeingSummary {
  agents: AgentWellbeing[];
  /** null when fewer than two agents work this week (nothing to compare). */
  loadBalanceIndex: number | null;
  agentsBelowMinRest: number;
  longestStreak: number;
  nightsRange: { min: number; max: number } | null;
}

interface Shift {
  day: number;
  startAbs: number;
  endAbs: number;
  night: boolean;
}

function shiftsOf(entry: AgentScheduleEntry): Shift[] {
  const out: Shift[] = [];
  for (const d of entry.days) {
    if (d.status !== "working" || !d.shiftStart || !d.shiftEnd) continue;
    const day = DAY_INDEX[d.dayOfWeek];
    if (day === undefined) continue;
    const s = toMinutes(d.shiftStart);
    const e = toMinutes(d.shiftEnd);
    const duration = e > s ? e - s : e + DAY - s; // end <= start means the shift crosses midnight
    const crossesMidnight = e <= s;
    // A night shift: crosses midnight, or starts in the evening (>= 20:00), or starts before 04:00.
    const night = crossesMidnight || s >= 20 * 60 || s < 4 * 60;
    out.push({ day, startAbs: day * DAY + s, endAbs: day * DAY + s + duration, night });
  }
  return out.sort((a, b) => a.startAbs - b.startAbs);
}

export function computeWellbeing(schedule: AgentScheduleEntry[], minimumRestHours: number): WellbeingSummary {
  const agents: AgentWellbeing[] = schedule.map((entry) => {
    const shifts = shiftsOf(entry);
    const hours = shifts.reduce((n, s) => n + (s.endAbs - s.startAbs) / 60, 0);
    const nights = shifts.filter((s) => s.night).length;
    const weekendDays = shifts.filter((s) => s.day >= 5).length;

    let longestStreak = 0;
    let streak = 0;
    let prevDay = -2;
    let minRest: number | null = null;
    let breaches = 0;
    for (let i = 0; i < shifts.length; i++) {
      const s = shifts[i];
      streak = s.day === prevDay + 1 ? streak + 1 : 1;
      longestStreak = Math.max(longestStreak, streak);
      if (i > 0 && s.day === shifts[i - 1].day + 1) {
        const rest = (s.startAbs - shifts[i - 1].endAbs) / 60;
        minRest = minRest === null ? rest : Math.min(minRest, rest);
        if (rest < minimumRestHours) breaches++;
      }
      prevDay = s.day;
    }

    return {
      employeeId: entry.employee.id,
      name: entry.employee.name,
      team: entry.employee.assignment,
      workedDays: shifts.length,
      hours: Math.round(hours * 10) / 10,
      nights,
      weekendDays,
      longestStreak,
      minRestHours: minRest === null ? null : Math.round(minRest * 10) / 10,
      restBreaches: breaches,
      burden: hours + NIGHT_WEIGHT_HOURS * nights + WEEKEND_WEIGHT_HOURS * weekendDays,
    };
  });

  const active = agents.filter((a) => a.workedDays > 0);
  let loadBalanceIndex: number | null = null;
  if (active.length >= 2) {
    const mean = active.reduce((n, a) => n + a.burden, 0) / active.length;
    const variance = active.reduce((n, a) => n + (a.burden - mean) ** 2, 0) / active.length;
    loadBalanceIndex = mean === 0 ? null : Math.max(0, Math.min(100, Math.round(100 - (100 * Math.sqrt(variance)) / mean)));
  }

  return {
    agents,
    loadBalanceIndex,
    agentsBelowMinRest: agents.filter((a) => a.restBreaches > 0).length,
    longestStreak: agents.reduce((n, a) => Math.max(n, a.longestStreak), 0),
    nightsRange: active.length ? { min: Math.min(...active.map((a) => a.nights)), max: Math.max(...active.map((a) => a.nights)) } : null,
  };
}
