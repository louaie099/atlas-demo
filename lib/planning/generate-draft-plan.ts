import { Employee, Flight, Assignment, Config, StaffingRequirement } from "../types";
import { computeWeeklyStaffingRequirements } from "./weekly-requirements";
import { aggregateDailyDemand, DailyDemand } from "./demand-aggregation";
import { generateFlexiblePoolShifts, GeneratedShiftAssignment, PriorDayShiftMap, enforceRestInvariantAcrossWeek, DroppedShiftForRest } from "./shift-generation";
import { generateProfilingMesureShifts, generateForeignCompanyShifts, DemandConflict } from "./specialized-team-generation";
import { generateObligationToppedUpShifts } from "./roster-generation";
import { generateDutiesForDay, GeneratedDuty, effectiveShiftForDay, resolvePlanRosterEntry } from "./duty-generation";
import { validateWeeklyPlan, collectConfigurationIssues, auditAverageWeeklyHoursFeasibility, auditStaticShiftRestFeasibility, PlanIssue, ConfigurationIssue } from "./validation";
import { isFlexibleGeneralPool, isGenerationDrivenPopulation } from "./workforce-pools";
import { getShiftDurationHours } from "../shift-templates";
import { flightDateFor } from "../flight-date";
import { CONFIGURED_COMPANIES } from "../company-config";
import { CheckinZoneId, CHECKIN_ZONE_IDS } from "../checkin-zones";
import { aggregateAllZonesDailyDemand, zoneDemandClusters, peakAggregateT1DemandMinuteForDay, aggregateT1DemandProfileForDay } from "./zone-demand-aggregation";

/** The pure, not-yet-persisted shape of one WeeklyPlanRosterEntry row (see lib/types.ts) -- `plan_id`/`id` are added by the persistence layer, never computed here. */
export interface PlanRosterEntryDraft {
  employee_id: string;
  day_of_week: string;
  status: "working" | "off";
  shift_code: string | null;
}

/**
 * The pure, not-yet-persisted shape of one checkin_zone_requirements row
 * (see supabase/migrations/0015_checkin_zones.sql / lib/types.ts's
 * ZoneCheckinRequirement) -- `id`/`plan_id` are added by the persistence
 * layer (weekly-plan-service.ts), never computed here, matching
 * PlanRosterEntryDraft's own convention above.
 */
export interface ZoneRequirementDraft {
  zone: CheckinZoneId;
  day_of_week: string;
  window_start: string;
  window_end: string;
  required_headcount: number;
  source: "automatic" | "manual";
  reasoning: string;
  contributingFlightIds: string[];
}

export interface DraftWeeklyPlan {
  weekLabel: string;
  daysOrder: string[];
  requirements: StaffingRequirement[];
  generatedShiftsByDay: Record<string, GeneratedShiftAssignment[]>;
  dutiesByDay: Record<string, GeneratedDuty[]>;
  // T1 Check-in ZONE DEMAND (2026-09-21 cutover; placement architecture
  // reworked 2026-09-23) -- computed entirely separately from the
  // flight-anchored `requirements`/`dutiesByDay` above (see
  // lib/checkin-zones.ts's module doc comment for why Check-in is no
  // longer a per-flight requirement at all). One entry per contiguous
  // demand cluster per zone per day (aggregateAllZonesDailyDemand/
  // zoneDemandClusters). There is deliberately no `zoneDutiesByDay` any
  // more: default T1 Check-in coverage (who is actually free to cover
  // this demand) is no longer generated here as a discrete duty at all —
  // it is DERIVED at read time from the roster + real specific-duty
  // intervals this same draft already produces (`rosterEntries`,
  // `dutiesByDay`), by lib/planning/checkin-capacity-timeline.ts. See
  // that module's doc comment for why (the old discrete-duty generation
  // here was the root cause of the "Required 4 / Assigned 75" bug).
  zoneRequirementsByDay: Record<string, ZoneRequirementDraft[]>;
  // The full, plan-scoped roster for the week -- every employee, every
  // day, "when are they planned to work and with what shift code" --
  // computed once here so persistence never has to re-derive it from
  // Employee.weekly_shifts later (see resolvePlanRosterEntry's doc
  // comment and lib/types.ts's WeeklyPlanRosterEntry).
  rosterEntries: PlanRosterEntryDraft[];
  // Operational Plan Warnings ONLY — rest/weekly-hours/consecutive-OFF
  // violations and unfilled duties. Never a configuration gap; see
  // configurationIssues below for that.
  issues: PlanIssue[];
  // Internal administrative/configuration gaps (no RAM staffing-matrix
  // rule for some aircraft/destination combination, or an unclassifiable
  // destination) — kept entirely separate from `issues` so nothing
  // downstream can fold them back into the operational summary. Reserved
  // for a future Administration/Configuration area; not surfaced in the
  // routine Weekly Planning UI today.
  configurationIssues: ConfigurationIssue[];
  generatedAt: string;
  // Shifts the whole-week hard rest-invariant safety net (see
  // enforceRestInvariantAcrossWeek) had to DROP after the two-pass
  // generation produced them, because they would have violated the 15h
  // minimum against that employee's true last-worked shift. Never
  // persisted; kept here purely for transparency/reporting — an empty
  // array is the expected, normal case.
  restViolationsPrevented: DroppedShiftForRest[];
}

/**
 * Runs Stage 6 (flexible-pool shift generation) across the whole week
 * exactly once, day by day, given a function that supplies each day's
 * "next day" rest-lookahead context. Returns the resulting
 * generatedShiftsByDay AND the running hours-so-far ledger (fairness
 * bookkeeping only — see shift-generation.ts's doc comment; never a hard
 * ceiling). Factored out because generation now runs this TWICE (see
 * runTwoPassShiftGeneration below) — once to discover what the flexible
 * pool would plausibly do on each day with only a same-week static
 * approximation for "tomorrow", then again using the FIRST pass's real
 * results as genuine next-day context, so the forward 15h rest check is
 * informed by what the demand-driven engine actually decided rather than
 * a template that no longer exists for this population.
 */

function runShiftGenerationPass(
  daysOrder: string[],
  weekStart: string,
  employees: Employee[],
  demandByDay: Record<string, DailyDemand>,
  config: Config,
  priorWeekBoundaryContext: PriorDayShiftMap,
  getNextDayBaseline: (dayIndex: number, nextDay: string) => PriorDayShiftMap,
  // STAGE-6 T1 AGGREGATE DEMAND BIAS (2026-09-23 follow-up) — this day's
  // per-30-min-bucket aggregate T1 demand profile, computed from the
  // flight schedule alone before Stage 6 ever runs (see
  // generateDraftWeeklyPlan below). Optional; omitted reproduces the exact
  // prior behavior for every existing caller/test.
  t1DemandByBucketByDay?: Record<string, number[]>
): { generatedShiftsByDay: Record<string, GeneratedShiftAssignment[]>; hoursSoFarThisWeek: Map<string, number> } {
  const generatedShiftsByDay: Record<string, GeneratedShiftAssignment[]> = {};
  const hoursSoFarThisWeek = new Map<string, number>();
  let priorDayShift: PriorDayShiftMap = new Map(priorWeekBoundaryContext);

  for (let dayIndex = 0; dayIndex < daysOrder.length; dayIndex++) {
    const day = daysOrder[dayIndex];
    const date = flightDateFor(weekStart, day);
    const nextDay = daysOrder[(dayIndex + 1) % daysOrder.length];
    const nextDayBaselineShift = getNextDayBaseline(dayIndex, nextDay);

    const generatedShifts = generateFlexiblePoolShifts(
      day,
      date,
      demandByDay[day],
      employees,
      priorDayShift,
      config.minimum_rest_hours,
      undefined,
      nextDayBaselineShift,
      hoursSoFarThisWeek,
      t1DemandByBucketByDay?.[day]
    );
    generatedShiftsByDay[day] = generatedShifts;

    for (const assignment of generatedShifts) {
      const hours = getShiftDurationHours(assignment.shiftCode, date);
      hoursSoFarThisWeek.set(assignment.employeeId, (hoursSoFarThisWeek.get(assignment.employeeId) ?? 0) + hours);
    }

    const nextPriorDayShift: PriorDayShiftMap = new Map();
    for (const employee of employees) {
      nextPriorDayShift.set(employee.id, effectiveShiftForDay(employee, day, generatedShifts, date));
    }
    priorDayShift = nextPriorDayShift;
  }

  return { generatedShiftsByDay, hoursSoFarThisWeek };
}

/**
 * Two-pass Stage 6, bounded to exactly two passes over the SELECTED week
 * (never an unbounded/iterative optimizer): normal (flexible-pool)
 * employees no longer carry a static baseline shift for "tomorrow" (see
 * duty-generation.ts's effectiveShiftForDay — that fallback was removed
 * so static weekly_shifts stops dictating this population's actual plan).
 * Without SOME next-day estimate, the forward half of the 15h rest gate
 * (shift-generation.ts's nextDayBaselineShift) would have nothing to
 * check against for this population, silently weakening a rule that must
 * stay hard-enforced.
 *
 * PASS 1 (discovery): generates the whole week using only non-flexible
 * employees' real static commitments as next-day context (flexible
 * employees get no forward lookahead this pass — same limitation as
 * having none at all, but only for this internal discovery pass, never
 * the final result).
 * PASS 2 (real): re-generates the whole week, this time using PASS 1's
 * OWN actual generated shifts as each day's real "what does this
 * employee actually do tomorrow" lookahead for the flexible pool (falling
 * back to the static baseline only for non-flexible employees, whose
 * commitment doesn't change between passes). This is what actually gets
 * returned and persisted — pass 1 is discarded after use.
 *
 * The week's own last day (Sunday) still only wraps to THIS same week's
 * Monday as a same-window approximation (pass 2 uses pass 1's Monday
 * result, which is a real, demand-informed value, not a static
 * placeholder — a genuine improvement over the old approximation, though
 * still not the literal following calendar week, which doesn't exist yet
 * at generation time; true next-week continuity is what
 * priorWeekBoundaryContext seeds from the OTHER direction for the window
 * after this one).
 */
function runTwoPassShiftGeneration(
  daysOrder: string[],
  weekStart: string,
  employees: Employee[],
  demandByDay: Record<string, DailyDemand>,
  config: Config,
  priorWeekBoundaryContext: PriorDayShiftMap,
  // STAGE-6 T1 AGGREGATE DEMAND BIAS (2026-09-23 follow-up) — see
  // runShiftGenerationPass's own doc comment on the parameter of the same
  // name. Passed identically to both passes so the bias is consistent
  // discovery-to-real, exactly like `demandByDay` itself already is.
  t1DemandByBucketByDay?: Record<string, number[]>
): { generatedShiftsByDay: Record<string, GeneratedShiftAssignment[]>; hoursSoFarThisWeek: Map<string, number> } {
  const staticBaselineOnly = (nextDay: string): PriorDayShiftMap => {
    const map: PriorDayShiftMap = new Map();
    const nextDate = flightDateFor(weekStart, nextDay);
    for (const employee of employees) {
      // Non-flexible employees: their real static commitment (unchanged
      // across passes). Flexible employees: no discovery-pass lookahead
      // (effectiveShiftForDay now returns null for them with an empty
      // generatedShifts array — see its doc comment) — pass 1 simply
      // runs without a forward check for this population, exactly as
      // pass 2 will correct.
      map.set(employee.id, effectiveShiftForDay(employee, nextDay, [], nextDate));
    }
    return map;
  };

  const pass1 = runShiftGenerationPass(
    daysOrder,
    weekStart,
    employees,
    demandByDay,
    config,
    priorWeekBoundaryContext,
    (_dayIndex, nextDay) => staticBaselineOnly(nextDay),
    t1DemandByBucketByDay
  );

  const pass2 = runShiftGenerationPass(
    daysOrder,
    weekStart,
    employees,
    demandByDay,
    config,
    priorWeekBoundaryContext,
    (dayIndex, nextDay) => {
      const map: PriorDayShiftMap = new Map();
      const nextDate = flightDateFor(weekStart, nextDay);
      const nextDayIndex = (dayIndex + 1) % daysOrder.length;
      const nextDayPass1Shifts = pass1.generatedShiftsByDay[daysOrder[nextDayIndex]] ?? [];
      for (const employee of employees) {
        if (isFlexibleGeneralPool(employee)) {
          map.set(employee.id, effectiveShiftForDay(employee, nextDay, nextDayPass1Shifts, nextDate));
        } else {
          map.set(employee.id, effectiveShiftForDay(employee, nextDay, [], nextDate));
        }
      }
      return map;
    },
    t1DemandByBucketByDay
  );

  return pass2;
}

/**
 * The full pipeline, Stage 1 through Stage 10, orchestrated. This is a
 * PURE, READ-ONLY computation — it never writes to the database. It
 * reads the current flights/employees/existing assignments and returns a
 * draft; nothing is persisted until a future "publish" step (explicitly
 * out of scope for this pass — see the report's Stage 11 notes).
 *
 * Order matters and mirrors the brief exactly:
 *  1-2. Weekly requirements (Stage 1/4) — computeWeeklyStaffingRequirements
 *       already accounts for foreign-company requirements (Stage 2) via
 *       the same classification used everywhere else, and now includes a
 *       GENERALIZED Check-in requirement for every RAM flight (see
 *       checkin-demand.ts), not one hardcoded flight id.
 *  3.   Fixed/specialized team recognition happens implicitly inside
 *       shift-generation (isFlexibleGeneralPool) and duty-generation
 *       (foreign commitments pre-populate busyWindows) — not a separate
 *       pass, since those exclusions are needed AT the point capacity is
 *       consumed, not before.
 *  5.   Demand aggregation, per day, computed for the WHOLE week up front
 *       (pure/cheap) so both shift-generation passes (see
 *       runTwoPassShiftGeneration) share identical demand numbers.
 *  6.   Flexible-pool shift generation is now genuinely DEMAND-DRIVEN,
 *       not template-driven: `RAM demand -> required capacity (peak/
 *       window) -> ranked compatible shift-code coverage -> employee
 *       roster/OFF placement`. Employee.weekly_shifts is no longer
 *       consulted as a fallback for this population at all (see
 *       duty-generation.ts's effectiveShiftForDay/resolvePlanRosterEntry)
 *       — an employee Stage 6 doesn't select for a day is genuinely OFF,
 *       a normal planning outcome, not a template gap. Cross-day rest
 *       stays cross-day-rest-aware exactly as before (`priorDayShift`),
 *       now made two-pass (see runTwoPassShiftGeneration) so the forward
 *       half of that check has a real next-day value to check against
 *       even though there's no more static fallback to borrow one from.
 *  7.   Profiling/Mesure: see specialized-demand.ts — deliberately not
 *       wired into requirement generation yet, since the rule for WHICH
 *       flights need them isn't confirmed, only the module shape is
 *       ready for when it is.
 *  8.   Reusing foreign-company ACEs outside their window: already true
 *       by construction — duty-generation only excludes an employee
 *       during their ACTUAL protected window (via occupiedWindows), never
 *       for their whole shift.
 *  9.   Individual duty generation, per day, in departure-time order.
 *  10.  Validation across the whole week.
 *
 * IMPORTANT — no calendar-week 42h gate: this pipeline used to reject a
 * candidate shift (and report a configuration gap) whenever it would
 * push a displayed-week total over the confirmed 42h number. That was
 * wrong: 42h is a confirmed AVERAGE (lib/labor-rules.ts's
 * maximumAverageWeeklyWorkingHours), not a Monday-Sunday ceiling, and the
 * real reference period it averages over is not yet confirmed (see
 * lib/planning/average-hours.ts). Generation therefore no longer rejects
 * anything on hours grounds — the `hoursSoFarThisWeek` ledger threaded
 * through shift-generation.ts is fairness bookkeeping ONLY (spreads
 * workload across otherwise-tied candidates), never compared against any
 * ceiling — and validation no longer emits a weekly_hours_violation or
 * capacity ConfigurationIssue from a single displayed week's total alone.
 * The 15h REST rule is unaffected — it is a genuinely continuous,
 * per-transition constraint (not a weekly sum) and remains hard-enforced
 * exactly as before, including the forward-looking check against the day
 * after the display window ends.
 */
export function generateDraftWeeklyPlan(
  flights: Flight[],
  employees: Employee[],
  existingAssignments: Assignment[],
  config: Config,
  daysOrder: string[],
  weekLabel: string,
  // The real Monday date this daysOrder window starts on ("YYYY-MM-DD").
  // Required — threaded to every shift-template lookup in this pipeline
  // (see lib/shift-templates.ts) so the shift regime effective on each
  // REAL calendar day (never the whole displayed week as one unit) is
  // resolved correctly, including for a window that straddles
  // 2026-09-20.
  weekStart: string,
  // Optional cross-plan continuity seed: each employee's REAL effective
  // shift on the calendar day immediately before this window's first day
  // (e.g. the immediately preceding WeeklyPlan's actual Sunday roster —
  // see lib/planning/rotation-context.ts and weekly-plan-service.ts's use
  // of it). Without this, priorDayShift would start empty and this
  // window's Monday would never be rest-checked against whatever the
  // employee actually worked the day before, which is exactly the kind
  // of Monday-reset this milestone corrects. Defaults to empty for a
  // genuinely first-ever window (no prior plan exists yet) — never a
  // reason to skip the check when a prior plan DOES exist.
  priorWeekBoundaryContext: PriorDayShiftMap = new Map()
): DraftWeeklyPlan {
  const requirements = computeWeeklyStaffingRequirements(flights, config);

  const demandByDay: Record<string, DailyDemand> = {};
  for (const day of daysOrder) {
    demandByDay[day] = aggregateDailyDemand(day, flights, requirements, config.checkin_demand_policy);
  }

  // STAGE-6 T1 AGGREGATE DEMAND BIAS (2026-09-23 follow-up to the product
  // owner's point 9) — computed from the flight schedule ALONE, entirely
  // independent of the roster Stage 6 is about to produce, and BEFORE
  // Stage 6 ever runs (moved up from where the single-peak-minute version
  // used to live, right before the secondary top-up pass) so the PRIMARY
  // shift-code chooser (generateFlexiblePoolShifts) can see it too, not
  // just the secondary obligation top-up pass. See
  // zone-demand-aggregation.ts's aggregateT1DemandProfileForDay and
  // shift-generation.ts's own doc comment on `t1DemandByBucket` for what
  // this does and does not change (a soft, weighted bias between already-
  // legal candidates, never an override of rest/consecutive-OFF/obligation
  // constraints, and a genuine unavoidable shortage still surfaces
  // honestly either way).
  const t1DemandByBucketByDay: Record<string, number[]> = {};
  const t1PeakDemandMinuteByDay: Record<string, number | null> = {};
  for (const day of daysOrder) {
    const dayFlights = flights.filter((f) => f.day_of_week === day && f.operator_type === "atlas_managed");
    t1DemandByBucketByDay[day] = aggregateT1DemandProfileForDay(day, dayFlights, config.zone_checkin_demand_policy);
    // Same semantics as before (bucket with the highest total, ties toward
    // earlier) — see zone-demand-aggregation.ts's own doc comment.
    t1PeakDemandMinuteByDay[day] = peakAggregateT1DemandMinuteForDay(day, dayFlights, config.zone_checkin_demand_policy);
  }

  const { generatedShiftsByDay: rawGeneratedShiftsByDay } = runTwoPassShiftGeneration(
    daysOrder,
    weekStart,
    employees,
    demandByDay,
    config,
    priorWeekBoundaryContext,
    t1DemandByBucketByDay
  );

  // HARD safety net (see enforceRestInvariantAcrossWeek's doc comment):
  // re-walks the whole week's real Stage 6 outcome one more time and
  // drops any shift that would violate the 15h minimum against that
  // employee's true last-worked shift, carrying forward across any
  // number of intervening OFF days and across the previous week's real
  // boundary shift. Everything downstream (duty generation, roster
  // persistence) runs on this REPAIRED result, never the raw one -- a
  // role a dropped shift would have covered becomes genuine, honestly
  // reported uncovered demand instead of an illegal roster.
  const { repaired: demandDrivenShiftsByDay, dropped: flexibleRestDropped } = enforceRestInvariantAcrossWeek(
    daysOrder,
    rawGeneratedShiftsByDay,
    config.minimum_rest_hours,
    weekStart,
    priorWeekBoundaryContext
  );

  // STAGE 2 of the redesigned pipeline (workforce obligation -> CONTINUOUS
  // ROSTER GENERATION -> shift assignment -> ...): see
  // lib/planning/roster-generation.ts's own doc comment for the full
  // rationale. A genuine no-op while config.working_hours_obligation_hours
  // stays null (today's real-world default) -- obligationToppedUpByDay is
  // then empty for every day and `generatedShiftsByDay` below is
  // byte-for-byte identical to `demandDrivenShiftsByDay`. Only once a real
  // obligation is confirmed and configured does this add real, additional
  // rostered-but-not-demand-justified days for the flexible pool, on top
  // of (never instead of) Stage 6's own demand-driven result.
  // STAGE-6 HEURISTIC BIAS (2026-09-23, product owner's point 9) for the
  // SECONDARY obligation top-up pass — `t1PeakDemandMinuteByDay` was
  // already computed above (shared with the PRIMARY pass's full-profile
  // bias) so it's simply reused here, not recomputed.
  const obligationToppedUpByDay = generateObligationToppedUpShifts(
    daysOrder,
    employees,
    demandDrivenShiftsByDay,
    config,
    priorWeekBoundaryContext,
    config.minimum_rest_hours,
    weekStart,
    t1PeakDemandMinuteByDay
  );
  const generatedShiftsByDay: Record<string, GeneratedShiftAssignment[]> = {};
  for (const day of daysOrder) {
    generatedShiftsByDay[day] = [...demandDrivenShiftsByDay[day], ...obligationToppedUpByDay[day]];
  }

  // Profiling/Mesure and every foreign-company team now also get a REAL,
  // generation-time roster instead of a static baseline (see
  // specialized-team-generation.ts's module comment for the full
  // rationale) — Profiling/Mesure from the SAME weekly demand aggregation
  // computed above, foreign companies from their own real flight
  // schedule. Both are already rest-aware internally (a candidate is only
  // ever selected if they leave the confirmed minimum rest since their
  // own real previous day), so by the time their output reaches the
  // universal safety net below, it should already be clean — the net
  // stays in place regardless, as a backstop, not the mechanism these
  // populations rely on to become legal.
  const { generatedShiftsByDay: profilingMesureShiftsByDay, conflicts: profilingMesureConflicts } = generateProfilingMesureShifts(
    daysOrder,
    employees,
    demandByDay,
    config.minimum_rest_hours,
    weekStart,
    priorWeekBoundaryContext
  );
  const { generatedShiftsByDay: foreignShiftsByDay, conflicts: foreignDemandConflicts } = generateForeignCompanyShifts(
    daysOrder,
    employees,
    flights,
    CONFIGURED_COMPANIES,
    config.minimum_rest_hours,
    weekStart,
    priorWeekBoundaryContext,
    // Normal RAM roster top-up (see specialized-team-generation.ts's own
    // doc comment) — foreign-company employees now get the same
    // "5 WORK + 2 OFF" normal roster target as the flexible pool,
    // constrained (not replaced) by their company's real flight days.
    config
  );

  // Every population whose day is decided by generation this run, merged
  // into one set — this, not any single population's own result alone,
  // is what duty generation and roster persistence must read from (see
  // isGenerationDrivenPopulation's doc comment).
  const allGeneratedShiftsByDay: Record<string, GeneratedShiftAssignment[]> = {};
  for (const day of daysOrder) {
    allGeneratedShiftsByDay[day] = [
      ...(generatedShiftsByDay[day] ?? []),
      ...(profilingMesureShiftsByDay[day] ?? []),
      ...(foreignShiftsByDay[day] ?? []),
    ];
  }

  // UNIVERSAL hard rest gate — everything above (flexible pool, Profiling/
  // Mesure, foreign companies) is already individually rest-aware, but
  // the confirmed 15h minimum is a hard EMPLOYEE constraint regardless of
  // which planning model produced a given day, so this still re-walks
  // EVERY employee's real week one more time as the final backstop the
  // milestone calls for — never the mechanism relied on to BECOME legal,
  // only the guarantee that nothing illegal reaches persistence even if
  // it somehow did. The remaining population here (still read from
  // static weekly_shifts) is now only the genuinely fixed teams: the
  // confirmed JR/NT/OFF/OFF cycle (Transit/Leaders/Duty Officers — see
  // teams.ts) and any other still-static team (Caisse/BCB, etc.).
  const combinedShiftsByDay: Record<string, GeneratedShiftAssignment[]> = {};
  for (const day of daysOrder) {
    const dayShifts = [...allGeneratedShiftsByDay[day]];
    for (const employee of employees) {
      if (isGenerationDrivenPopulation(employee)) continue; // already included above
      const existing = employee.weekly_shifts.find((s) => s.day_of_week === day);
      if (existing?.status === "working" && existing.shift_code) {
        dayShifts.push({ employeeId: employee.id, dayOfWeek: day, shiftCode: existing.shift_code, coversRoles: [] });
      }
    }
    combinedShiftsByDay[day] = dayShifts;
  }

  const generationDrivenEmployeeIds = new Set(employees.filter(isGenerationDrivenPopulation).map((e) => e.id));
  const { dropped: universallyDropped, restHoursByEmployeeDay } = enforceRestInvariantAcrossWeek(
    daysOrder,
    combinedShiftsByDay,
    config.minimum_rest_hours,
    weekStart,
    priorWeekBoundaryContext,
    generationDrivenEmployeeIds
  );

  // Anything newly dropped in THIS pass beyond the flexible-pool repair
  // above can only belong to a non-flexible employee — the flexible
  // pool's own result was already internally rest-consistent going in.
  // This is either a genuinely fixed team's configured rotation failing
  // 15h on its own (shouldn't happen for the confirmed JR/NT/OFF/OFF
  // cycle — see fixed-cycle-rotation.ts), OR — should also read as zero
  // in practice — a leftover from Profiling/Mesure/foreign generation
  // that its own internal rest-awareness somehow missed. Either way, it
  // is never silently persisted.
  const employeesById = new Map(employees.map((e) => [e.id, e]));
  const specializedRestConflicts = universallyDropped.filter(
    (d) => !isFlexibleGeneralPool(employeesById.get(d.employeeId)!)
  );

  // Two different populations need two different corrections for the
  // same finding: a STATIC team's authoritative source is
  // Employee.weekly_shifts (patched below, narrowly, day by day); a
  // GENERATION-DRIVEN team's authoritative source is
  // allGeneratedShiftsByDay itself (resolvePlanRosterEntry/
  // effectiveShiftForDay ignore weekly_shifts for this population
  // entirely — see isGenerationDrivenPopulation), so the offending
  // generated entry is removed directly instead.
  const droppedDaysByEmployee = new Map<string, Set<string>>();
  for (const d of specializedRestConflicts) {
    if (!droppedDaysByEmployee.has(d.employeeId)) droppedDaysByEmployee.set(d.employeeId, new Set());
    droppedDaysByEmployee.get(d.employeeId)!.add(d.dayOfWeek);
  }

  const finalGeneratedShiftsByDay: Record<string, GeneratedShiftAssignment[]> = {};
  for (const day of daysOrder) {
    finalGeneratedShiftsByDay[day] = allGeneratedShiftsByDay[day].filter((g) => {
      const droppedDays = droppedDaysByEmployee.get(g.employeeId);
      return !(droppedDays?.has(g.dayOfWeek) && isGenerationDrivenPopulation(employeesById.get(g.employeeId)!));
    });
  }

  // Patch a working copy of only the AFFECTED, genuinely-static
  // employees' weekly_shifts so every downstream step (duty generation,
  // resolvePlanRosterEntry, validation) sees the corrected week instead
  // of the illegal one. Deliberately narrow: only the specific offending
  // day(s) are touched — this never rewrites a specialized team's own
  // configured rotation wholesale, per the delivered report's explicit
  // instruction not to arbitrarily rewrite specialized rotations without
  // understanding them. The underlying structural finding is still
  // reported in full via auditStaticShiftRestFeasibility below (against
  // the ORIGINAL, unpatched employees) so the real fix — correcting that
  // team's configured cycle — stays visible, not papered over.
  const employeesForPipeline: Employee[] = employees.map((employee) => {
    const droppedDays = droppedDaysByEmployee.get(employee.id);
    if (!droppedDays || isGenerationDrivenPopulation(employee)) return employee;
    return {
      ...employee,
      weekly_shifts: employee.weekly_shifts.map((s) =>
        droppedDays.has(s.day_of_week) ? { ...s, status: "off" as const, shift_code: null } : s
      ),
    };
  });

  // Hours-based fairness input for Stage 9 (see scoring.ts's
  // hoursScheduledThisWindow doc comment) -- total real generated shift
  // hours per employee across the WHOLE week's final roster, computed
  // once here so every day's duty-scoring pass shares the same fairness
  // signal. A genuine no-op while config.fairness_weights.workloadHoursWeight
  // is 0 (the default) -- this map is only ever consulted then.
  const hoursScheduledThisWindow = new Map<string, number>();
  for (const day of daysOrder) {
    const date = flightDateFor(weekStart, day);
    for (const g of finalGeneratedShiftsByDay[day] ?? []) {
      hoursScheduledThisWindow.set(g.employeeId, (hoursScheduledThisWindow.get(g.employeeId) ?? 0) + getShiftDurationHours(g.shiftCode, date));
    }
  }

  const dutiesByDay: Record<string, GeneratedDuty[]> = {};
  const allUnfilled: { dayOfWeek: string; requirementId: string; role: string; stillNeeded: number }[] = [];

  for (const day of daysOrder) {
    const { duties, unfilled } = generateDutiesForDay(
      day,
      requirements,
      flights,
      employeesForPipeline,
      finalGeneratedShiftsByDay[day] ?? [],
      existingAssignments,
      config,
      flightDateFor(weekStart, day),
      restHoursByEmployeeDay,
      hoursScheduledThisWindow
    );
    dutiesByDay[day] = duties;
    allUnfilled.push(...unfilled);
  }

  // T1 CHECK-IN ZONE MODEL -- ZONE DEMAND ONLY (2026-09-23 architecture
  // refactor). This block used to ALSO run a "default placement" stage
  // here (computeDefaultCheckinZonePlacement) and persist its output as
  // discrete checkin_zone_assignments rows. That is exactly the
  // architecture the product owner's audit found responsible for the live
  // "Required 4 / Assigned 75" bug (a broad placement-duty window
  // mis-linked to the wrong zone-requirement row by weekly-plan-service.ts's
  // now-removed findZoneRequirementIdFor). Per the owner's explicit
  // instruction, default T1 Check-in coverage is no longer generated or
  // persisted as a duty at all -- it is DERIVED at read time from the
  // roster + real specific-duty intervals already persisted here (see
  // lib/planning/checkin-capacity-timeline.ts, used by
  // persisted-plan-view.ts). This block therefore only computes and
  // returns DEMAND (zoneRequirementsByDay) -- the real aggregated workload
  // each zone needs, from this week's RAM flight program alone
  // (aggregateAllZonesDailyDemand/zoneDemandClusters), entirely
  // independent of how many employees happen to be free. It is still
  // persisted (checkin_zone_requirements) because it is genuinely useful,
  // real, and unaffected by the bug -- only the discrete-assignment side
  // was wrong.
  const zoneRequirementsByDay: Record<string, ZoneRequirementDraft[]> = {};

  for (const day of daysOrder) {
    const dayFlights = flights.filter((f) => f.day_of_week === day && f.operator_type === "atlas_managed");
    const zoneDemandByZone = aggregateAllZonesDailyDemand(day, dayFlights, config.zone_checkin_demand_policy);

    const zoneRequirements: ZoneRequirementDraft[] = [];
    for (const zone of CHECKIN_ZONE_IDS) {
      const clusters = zoneDemandClusters(zoneDemandByZone[zone]);
      for (const cluster of clusters) {
        zoneRequirements.push({
          zone,
          day_of_week: day,
          window_start: cluster.start,
          window_end: cluster.end,
          required_headcount: cluster.peak,
          source: "automatic",
          reasoning: `Aggregate T1 Check-in demand for ${cluster.start}–${cluster.end} across ${cluster.contributingFlightIds.length} flight(s) sharing this zone (prototype/configurable demand policy, not yet confirmed management policy -- see lib/planning/checkin-zone-demand.ts).`,
          contributingFlightIds: cluster.contributingFlightIds,
        });
      }
    }
    zoneRequirementsByDay[day] = zoneRequirements;
  }

  const rosterEntries: PlanRosterEntryDraft[] = [];
  for (const day of daysOrder) {
    for (const employee of employeesForPipeline) {
      const resolved = resolvePlanRosterEntry(employee, day, finalGeneratedShiftsByDay[day] ?? []);
      rosterEntries.push({ employee_id: employee.id, day_of_week: day, ...resolved });
    }
  }

  // Validation (rest, consecutive-OFF, average-hours diagnostics) must
  // check the REAL plan-scoped roster (rosterEntries) — not
  // Employee.weekly_shifts. That static baseline is no longer authoritative
  // for the flexible pool's actual day-by-day outcome (see
  // duty-generation.ts's effectiveShiftForDay/resolvePlanRosterEntry), so
  // validating against it directly would check the wrong data — a genuine
  // divergence now, not a rare override, since the flexible pool's
  // real work/OFF pattern is demand-driven and can differ substantially
  // from their static template on any given day. This rebuild is a
  // uniform, safe no-op for every non-flexible employee (their
  // rosterEntries already mirror weekly_shifts exactly).
  const employeesWithPlannedRoster: Employee[] = employeesForPipeline.map((employee) => ({
    ...employee,
    weekly_shifts: daysOrder.map((day) => {
      const entry = rosterEntries.find((r) => r.employee_id === employee.id && r.day_of_week === day)!;
      return { day_of_week: day, status: entry.status, shift_code: entry.shift_code };
    }),
  }));

  // BLOCKING findings for this run's own specialized-rest conflicts —
  // distinct from auditStaticShiftRestFeasibility's general structural
  // finding below (which reports the underlying configured-rotation
  // problem regardless of whether this particular week happened to
  // trigger it). Never silently folded into an ordinary unfilled_duty —
  // this is a workforce-design conflict in a FIXED configuration, not an
  // ordinary demand/coverage shortfall.
  const specializedRestConflictIssues: ConfigurationIssue[] = specializedRestConflicts.map((d) => {
    const employee = employeesById.get(d.employeeId)!;
    return {
      requirementId: `specialized-rest-conflict-${d.employeeId}-${d.dayOfWeek}`,
      description: `BLOCKING: ${employee.name} (${employee.assignment})'s configured fixed rotation would only provide ${d.restHours}h rest before ${d.dayOfWeek}'s ${d.shiftCode} shift — below the confirmed ${config.minimum_rest_hours}h minimum. This day has been left OFF rather than persisting an illegal sequence; the plan is intentionally incomplete here. Resolve by adjusting this specialized team's configured rotation — not something ATLAS can fix automatically.`,
    };
  });

  // BLOCKING findings for a genuine COVERAGE shortfall in Profiling/
  // Mesure/foreign-company generation — distinct from a rest conflict
  // above: this is "nobody in the team's own pool could be found who is
  // both rested and holds a compatible catalog shift for this real
  // window," reported exactly as such rather than silently persisting a
  // rest-violating fallback (the previous foreign-company behavior this
  // milestone removes) or fabricating coverage from nowhere.
  const demandConflictIssues: ConfigurationIssue[] = [...profilingMesureConflicts, ...foreignDemandConflicts].map((c) => ({
    requirementId: `specialized-demand-conflict-${c.team}-${c.dayOfWeek}`,
    description: `BLOCKING: ${c.team} needed ${c.needed} staff member(s) for its ${c.dayOfWeek} operation (${c.window.start}–${c.window.end}) but only ${c.covered} could be legally covered — no other team member was both rested (${config.minimum_rest_hours}h confirmed minimum) and held a compatible catalog shift for this window. The plan is intentionally incomplete here rather than persisting an illegal or fabricated assignment. Resolve with a workforce-design decision (headcount, or a confirmed shift-code policy for this team) — not something ATLAS can fix automatically.`,
  }));

  const issues = validateWeeklyPlan(allUnfilled, employeesWithPlannedRoster, daysOrder, config, weekStart);
  const configurationIssues = [
    ...collectConfigurationIssues(requirements),
    // Average-hours feasibility: returns [] until a reference period is
    // confirmed (see auditAverageWeeklyHoursFeasibility's doc comment in
    // validation.ts) — never emitted from a single displayed week alone.
    // Uses the real planned roster too, for the same reason as above.
    // isGenerationDrivenPopulation (not just the flexible pool) is
    // excluded here -- Profiling/Mesure/foreign employees' STATIC
    // weekly_shifts baseline is no longer what's actually planned for
    // them (see specialized-team-generation.ts), so auditing it would
    // report a stale, no-longer-relevant finding.
    ...auditAverageWeeklyHoursFeasibility(employeesWithPlannedRoster, isGenerationDrivenPopulation, config, weekStart),
    ...auditStaticShiftRestFeasibility(employees, isGenerationDrivenPopulation, config, weekStart),
    ...specializedRestConflictIssues,
    ...demandConflictIssues,
  ];

  return {
    weekLabel,
    daysOrder,
    requirements,
    generatedShiftsByDay: finalGeneratedShiftsByDay,
    dutiesByDay,
    zoneRequirementsByDay,
    rosterEntries,
    issues,
    configurationIssues,
    generatedAt: new Date().toISOString(),
    restViolationsPrevented: [...flexibleRestDropped, ...specializedRestConflicts],
  };
}
