import { Employee, Flight } from "../types";
import { DailyDemand, demandClustersForRole } from "./demand-aggregation";
import { selectCompatibleShiftCodes, planForeignCompanyDay } from "../foreign-shift-planning";
import { getCompanyRequiredAgents } from "../company-config";
import { GeneratedShiftAssignment, PriorDayShiftMap } from "./shift-generation";
import { getShiftTimesAs } from "../shift-templates";

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
 */

/** One day's genuine shortfall: this many fewer employees could be legally rostered than the real demand/commitment needed. */
export interface DemandConflict {
  team: string; // "Profiling" | "Mesure" | a foreign company name
  dayOfWeek: string;
  window: { start: string; end: string };
  needed: number;
  covered: number;
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
  minimumRestHours: number
): { assigned: { employeeId: string; shiftCode: string }[]; shortfall: number } {
  const assigned: { employeeId: string; shiftCode: string }[] = [];
  for (const employee of pool) {
    if (assigned.length >= headcount) break;
    const prior = priorDayShift.get(employee.id) ?? null;
    const candidates = selectCompatibleShiftCodes(
      window.start,
      window.end,
      prior?.shift_start ?? null,
      prior?.shift_end ?? null,
      minimumRestHours
    );
    if (candidates.length > 0) {
      assigned.push({ employeeId: employee.id, shiftCode: candidates[0].code });
    }
  }
  return { assigned, shortfall: Math.max(0, headcount - assigned.length) };
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
  priorWeekBoundaryContext: PriorDayShiftMap = new Map()
): { generatedShiftsByDay: Record<string, GeneratedShiftAssignment[]>; conflicts: DemandConflict[] } {
  const generatedShiftsByDay: Record<string, GeneratedShiftAssignment[]> = {};
  const conflicts: DemandConflict[] = [];

  for (const team of ["Profiling", "Mesure"]) {
    const pool = employees.filter((e) => e.active && e.assignment === team);
    let priorDayShift: PriorDayShiftMap = new Map(priorWeekBoundaryContext);

    for (const day of daysOrder) {
      const clusters = demandClustersForRole(demandByDay[day], team);
      const dayAssignments: { employeeId: string; shiftCode: string }[] = [];
      let remainingPool = pool;

      for (const cluster of clusters) {
        const { assigned, shortfall } = assignPoolToWindow(remainingPool, cluster, cluster.peak, priorDayShift, minimumRestHours);
        dayAssignments.push(...assigned);
        const assignedIds = new Set(assigned.map((a) => a.employeeId));
        remainingPool = remainingPool.filter((e) => !assignedIds.has(e.id));
        if (shortfall > 0) {
          conflicts.push({
            team,
            dayOfWeek: day,
            window: { start: cluster.start, end: cluster.end },
            needed: cluster.peak,
            covered: cluster.peak - shortfall,
          });
        }
      }

      if (!generatedShiftsByDay[day]) generatedShiftsByDay[day] = [];
      for (const a of dayAssignments) {
        generatedShiftsByDay[day].push({ employeeId: a.employeeId, dayOfWeek: day, shiftCode: a.shiftCode, coversRoles: [team] });
      }

      const nextPriorDayShift: PriorDayShiftMap = new Map();
      for (const employee of pool) {
        const a = dayAssignments.find((x) => x.employeeId === employee.id);
        nextPriorDayShift.set(employee.id, a ? getShiftTimesAs(a.shiftCode) : null);
      }
      priorDayShift = nextPriorDayShift;
    }
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
 * invented here. A day with no company flight at all leaves the whole
 * group OFF — no fabricated baseline shift on a day nothing requires one;
 * per the confirmed instruction, their unused availability is not yet
 * redirected to general RAM demand in this milestone.
 */
export function generateForeignCompanyShifts(
  daysOrder: string[],
  employees: Employee[],
  flights: Flight[],
  configuredCompanies: string[],
  minimumRestHours: number,
  priorWeekBoundaryContext: PriorDayShiftMap = new Map()
): { generatedShiftsByDay: Record<string, GeneratedShiftAssignment[]>; conflicts: DemandConflict[] } {
  const generatedShiftsByDay: Record<string, GeneratedShiftAssignment[]> = {};
  const conflicts: DemandConflict[] = [];

  for (const company of configuredCompanies) {
    const pool = employees.filter((e) => e.active && e.assignment === company);
    if (pool.length === 0) continue;
    const headcount = getCompanyRequiredAgents(company);
    let priorDayShift: PriorDayShiftMap = new Map(priorWeekBoundaryContext);

    for (const day of daysOrder) {
      const plan = planForeignCompanyDay(company, day, flights);
      let dayAssignments: { employeeId: string; shiftCode: string }[] = [];

      if (plan && headcount !== undefined) {
        const { assigned, shortfall } = assignPoolToWindow(pool, plan.combinedWindow, headcount, priorDayShift, minimumRestHours);
        dayAssignments = assigned;
        if (shortfall > 0) {
          conflicts.push({ team: company, dayOfWeek: day, window: plan.combinedWindow, needed: headcount, covered: headcount - shortfall });
        }
      }
      // No flight today (plan === null), or no confirmed headcount for
      // this company (shouldn't happen for a CONFIGURED company, but
      // never invent one if it did) -- the whole group is genuinely OFF,
      // never given a fabricated baseline shift.

      if (!generatedShiftsByDay[day]) generatedShiftsByDay[day] = [];
      for (const a of dayAssignments) {
        generatedShiftsByDay[day].push({ employeeId: a.employeeId, dayOfWeek: day, shiftCode: a.shiftCode, coversRoles: [company] });
      }

      const nextPriorDayShift: PriorDayShiftMap = new Map();
      for (const employee of pool) {
        const a = dayAssignments.find((x) => x.employeeId === employee.id);
        nextPriorDayShift.set(employee.id, a ? getShiftTimesAs(a.shiftCode) : null);
      }
      priorDayShift = nextPriorDayShift;
    }
  }

  return { generatedShiftsByDay, conflicts };
}
