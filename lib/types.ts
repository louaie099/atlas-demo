export type RequirementSource = "fixed_rule" | "demand_forecast" | "company_config";
export type BookingPressure = "normal" | "elevated";
export type FlightStatus = "scheduled" | "delayed";
export type CandidateStatus = "recommended" | "flagged";
export type PlannedDutyStatus = "planned" | "reassigned";
export type OperatorType = "atlas_managed" | "self_managed";
// Collapsed from the earlier "covered" | "proposed" | "needs_configuration"
// set. Ordinary generated staffing is now a plain ASSIGNMENT the moment the
// draft plan covers the requirement -- whether the specific employee comes
// from a real Assignment row or from the engine's own draft duty no longer
// changes how it reads in Flight Coverage; "proposed"/recommendation
// language is reserved for exceptional cases (renfort, live-conflict
// reassignment), which this static weekly-plan status does not represent.
// "needs_configuration" is no longer a coverage status at all -- a
// genuinely unconfigured internal RAM rule surfaces only as a PlanIssue
// (see lib/planning/validation.ts), never as a per-flight coverage state,
// and an unconfigured foreign carrier now produces no requirement (and so
// no coverage row) whatsoever -- see lib/planning/weekly-requirements.ts.
export type RequirementCoverageStatus = "assigned" | "gap" | "conflict";

export interface WeeklyShiftEntry {
  day_of_week: string;
  shift_code: string | null; // null when status is "off"
  status: "working" | "off";
}

export interface Employee {
  id: string;
  name: string;
  skills: string[]; // CAPABILITY — what this employee is trained/authorized to perform on a flight task (Boarding, Gate, Check-in, etc.)
  assignment: string; // CURRENT PLACEMENT — where this employee is actually working: an internal RAM service (see teams.ts) or a foreign company name (see company-config.ts). Distinct from foreign_company_authorizations, which is capability, not current placement.
  shift_code: string | null; // authoritative code from lib/shift-templates.ts; null only for scenario-critical legacy cases (see seed-data.ts comments) OR a newly-created employee with no roster yet
  // Planning state, not identity — derived from Weekly Planning/roster
  // generation, never entered at employee creation. All four are null
  // for a freshly-created employee until a roster assigns them a shift.
  shift_start: string | null; // "HH:mm"
  shift_end: string | null; // "HH:mm"
  rest_before_shift_hours: number | null;
  weekly_hours: number | null;
  is_duty_officer: boolean;
  // e.g. ["Thursday"] — days this employee's durable BASELINE/TEMPLATE
  // pattern (see weekly_shifts below) has them not working. NOT
  // authoritative for what actually gets planned for any given displayed
  // week: for the flexible General T1 pool, Stage 6
  // (lib/planning/shift-generation.ts) generates the real day-by-day
  // choice from operational demand, and the persisted
  // WeeklyPlanRosterEntry that results is the single source of truth for
  // "what did this employee actually do on this calendar day" (see
  // lib/planning/duty-generation.ts's resolvePlanRosterEntry). off_days
  // is kept as a durable config/fallback default (what an employee falls
  // back to on a day Stage 6 never touched, and what static/fixed-team
  // employees' real commitment already legitimately is), not as this
  // week's real plan.
  off_days: string[];
  foreign_company_authorizations: string[]; // e.g. ["Qatar Airways"] — companies they're TRAINED/AUTHORIZED to work (capability). Does NOT mean currently placed there — that's what `assignment` represents. Being authorized never removes RAM availability outside an actual protected window (see foreign-company-window.ts).
  active: boolean; // workforce status — editable only by Administrators (see lib/roles.ts). An inactive employee is never a scoring candidate.
  // TEAM COMPOSITION — a genuinely separate concept from `skills`
  // (qualification) and `assignment` (current placement): this is the
  // employee's ROLE/RESPONSIBILITY within their own team, e.g. an
  // interchangeable "ace" ground-service agent vs. a "leader" who
  // coordinates the team rather than filling a generic staffing slot.
  // Optional and `undefined` for every employee whose team has no
  // confirmed role split (see lib/company-config.ts's
  // getCompanyTeamRoleConfig) — undefined means "no distinct role
  // configured, fully interchangeable," the same behavior every team had
  // before this field existed. Only set (currently only for Gulf Air,
  // 7 ace + 1 leader — a confirmed real fact, see company-config.ts) once
  // a company's real role split is confirmed; never guessed for any other
  // team. This is NOT a qualification (`skills`) and NOT the per-flight
  // STAFFING REQUIREMENT count (StaffingRequirement.total_requirement) —
  // those three stay separate concepts on purpose so a future team can
  // have distinct roles without distinct skills, or vice versa.
  team_role?: "ace" | "leader";
  // Employee-level BASELINE/TEMPLATE pattern — one entry per day of a
  // generic week, each with its own shift code or "off" status. For a
  // static/fixed-planning-team/foreign-committed employee this template
  // already IS their real, established commitment (generation never
  // touches them). For a FLEXIBLE General T1 pool employee, this is only
  // a durable FALLBACK default: the day-by-day pattern they'd work if
  // Stage 6 generation doesn't need/select them for a given day (see
  // effectiveShiftForDay/resolvePlanRosterEntry in
  // lib/planning/duty-generation.ts) — it is deliberately NOT re-written
  // per displayed week and does NOT reset at a Monday boundary; the
  // employee's actual continuous work/OFF rotation across real calendar
  // weeks lives in the persisted WeeklyPlanRosterEntry rows for each
  // WeeklyPlan (see lib/planning/rotation-context.ts for how one week's
  // plan seeds rest-continuity from the immediately preceding week's real
  // roster). Do not read this field as "this employee's plan for the
  // current week" — read the current WeeklyPlan's roster entries instead.
  weekly_shifts: WeeklyShiftEntry[];
}

export interface Flight {
  id: string;
  flight_number: string;
  airline: string;
  route: string;
  origin: string | null;
  destination: string | null;
  aircraft: string;
  equipment_code: string | null;
  registration: string | null;
  callsign: string | null;
  terminal: string | null;
  scheduled_departure: string; // "HH:mm"
  scheduled_arrival: string | null;
  gate: string | null;
  boarding_window_start: string | null;
  boarding_window_end: string | null;
  status: FlightStatus;
  booking_pressure: BookingPressure;
  day_of_week: string; // e.g. "Wednesday" — derived from flight_date, kept alongside it since most existing code reads this directly
  // The actual calendar date this flight occurs on, and the Monday that
  // starts its display week (week_start is a pure grouping/indexing key —
  // every real chronological question, including cross-week rest
  // adjacency, must be answered from flight_date, never from day_of_week
  // or week_start alone). flight_date's weekday MUST match day_of_week —
  // enforced by a CHECK constraint at the database level (migration
  // 0013), not just assumed by application code.
  flight_date: string; // "YYYY-MM-DD"
  week_start: string; // "YYYY-MM-DD" — the Monday of flight_date's display week
  operator_type: OperatorType; // atlas_managed (RAM/own ops) vs self_managed (foreign carrier)
  destination_category: string | null; // e.g. "Europe/Schengen", "UK/USA" — RAM flights only
  // Passenger load — architecture only for now (see lib/flight-generator.ts).
  // Available to planning logic and to the Flight Schedule detail view, but
  // no staffing rule reads it yet; a rule would need to be explicitly
  // confirmed and configured before load ever changes a headcount.
  booked_passengers: number | null;
  seat_capacity: number | null;
}

export interface StaffingRequirement {
  id: string;
  flight_id: string;
  role: string;
  baseline_requirement: number;
  additional_requirement: number;
  total_requirement: number;
  source: RequirementSource;
  reasoning: string;
  needs_configuration: boolean; // true when no operation rule / company config exists yet
}

// "atlas_generated" = created automatically when a Draft Weekly Plan was
// generated/regenerated -- a normal ATLAS assignment, never a pending
// recommendation. "human_modified" = a planner's own action against an
// existing plan (today: a Find Agent gap fill; a future swap/replace would
// be the same source). See AssignmentModification below for the
// structured history of human_modified changes -- this field alone says
// WHO currently owns the row, not what (if anything) it replaced.
export type AssignmentSource = "atlas_generated" | "human_modified";

export interface Assignment {
  id: string;
  // Every assignment belongs to exactly one WeeklyPlan -- there is no more
  // "global" assignment floating outside planning context. See
  // lib/planning/weekly-plan-service.ts.
  plan_id: string;
  staffing_requirement_id: string;
  employee_id: string;
  source: AssignmentSource;
  // The planner's name for a human_modified row; null for atlas_generated
  // (nothing to attribute -- see the audit log for the plan-level
  // generation event instead).
  created_by: string | null;
  assigned_at: string;
}

export type WeeklyPlanStatus = "draft" | "published";

/**
 * The planning aggregate root (see lib/planning/weekly-plan-service.ts).
 * One row per week. A browser refresh reads this row's persisted roster/
 * assignments -- it never triggers a fresh computation. `revision`
 * increments only on an explicit Regenerate (see the service's
 * modification-blocking rule); `generated_from_hash` is a content hash of
 * the facts (flights/employees/config) the current revision was generated
 * from, so staleness against later-changed inputs is DETECTABLE without a
 * full historical-versioning subsystem. `config_snapshot` freezes the
 * resolved labor/operational rules this revision was generated and
 * validated under, so a later rule change can never silently reinterpret
 * an already-generated (let alone published) plan.
 */
export interface WeeklyPlan {
  id: string;
  week_start: string; // ISO date -- the Monday of the planned week
  week_label: string;
  status: WeeklyPlanStatus;
  revision: number;
  generated_at: string;
  published_at: string | null;
  generated_from_hash: string;
  config_snapshot: Config;
  // Generation-time Plan Warnings/configuration gaps, frozen at generation
  // time -- never recomputed live on read. See lib/planning/validation.ts.
  issues: import("./planning/validation").PlanIssue[];
  configuration_issues: import("./planning/validation").ConfigurationIssue[];
}

/**
 * The persisted result of "when is this employee planned to work this
 * week" -- one row per (plan, employee, day), for EVERY employee
 * regardless of group (fixed-cycle, foreign-committed, flexible pool
 * alike). This is what makes the generated week's actual roster durable
 * and plan-scoped instead of silently re-derivable (and therefore
 * driftable) from Employee.weekly_shifts, which stays only as permanent/
 * baseline workforce data -- never the live source of truth for a
 * generated plan's read path once that plan exists. See
 * lib/planning/weekly-plan-service.ts and lib/planning/duty-generation.ts's
 * resolvePlanRosterEntry (the single function that computes this at
 * generation time, for every employee group alike).
 */
export interface WeeklyPlanRosterEntry {
  id: string;
  plan_id: string;
  employee_id: string;
  day_of_week: string;
  status: "working" | "off";
  shift_code: string | null; // null when status is "off"
}

export type AssignmentModificationAction = "added" | "replaced" | "removed";

/**
 * Append-only structured history of human changes to a plan's
 * assignments -- never a mutation of the live Assignment row itself, so
 * "what did ATLAS originally assign here?" stays answerable. Scoped by
 * `plan_revision` (not just `plan_id`) because Regenerate increments the
 * plan's revision -- without this, a modification row would become
 * ambiguous as to which generation of the draft it actually applied to.
 * Today only `action: "added"` is produced (a Find Agent gap fill);
 * "replaced"/"removed" are represented for a future swap/unassign action,
 * not yet wired to any route.
 */
export interface AssignmentModification {
  id: string;
  plan_id: string;
  plan_revision: number;
  staffing_requirement_id: string;
  action: AssignmentModificationAction;
  previous_employee_id: string | null; // null when action === "added"
  new_employee_id: string | null; // null when action === "removed"
  changed_by: string;
  changed_at: string;
  reason: string | null;
}

export interface PlannedDuty {
  id: string;
  employee_id: string;
  task: string;
  planned_start: string; // "HH:mm"
  status: PlannedDutyStatus;
  reassigned_to_employee_id: string | null;
}

export interface AuditLogEntry {
  id: string;
  step_number: number;
  description: string;
  timestamp: string;
}

export interface CandidateResult {
  employee: Employee;
  status: CandidateStatus;
  reasoning: string;
  /**
   * FATIGUE EXPLAINABILITY (2026-09-24, fatigue milestone part 2) — present
   * ONLY on "recommended" candidates when scoreCandidates ran with
   * fairness_weights.fatigueWeight > 0 and an enabled fatigue input:
   * neutral, digit-free labels (explainFatigueFactors) describing this
   * candidate's recent burden vs the next-ranked recommended candidate.
   * Absent otherwise, so default output is byte-identical to before.
   */
  fatigueReason?: string[];
}

export interface RosterRequirementView {
  requirement: StaffingRequirement;
  flight: Flight;
  assignedEmployees: Employee[]; // CONFIRMED — real Assignment rows
  proposedEmployees: Employee[]; // ATLAS-assigned — from the engine's generated draft plan; a normal draft-plan assignment, not an exceptional recommendation (see RequirementCoverageStatus)
  gap: number; // still unmet even counting the engine's own draft assignments
  coverageStatus: RequirementCoverageStatus;
  // Display label for the compact coverage chip/detail heading — the
  // requirement's own role (Gate/Boarding/Profiling/Mesure/Check-in) for
  // RAM flights, or "{Airline} Team" for a company_config (foreign-carrier)
  // requirement. `requirement.role` for a company_config requirement is
  // the neutral internal identifier "Company Team" (see company-config.ts)
  // — it carries no scoring weight (eligibility there is real company
  // authorization, not a skill match — see lib/scoring.ts's
  // requiredAuthorization parameter), it's just a label. coverageLabel is
  // the friendlier one actually shown in Flight Coverage.
  coverageLabel: string;
}

export interface ConflictInfo {
  employee: Employee;
  flightId: string;
  plannedDuty: PlannedDuty;
  overlapMinutes: number;
}

export interface ResolutionRecommendation {
  plannedDuty: PlannedDuty;
  recommendedEmployee: Employee;
  reasoning: string;
}

export interface Config {
  // Confirmed: minimum hours between the end of one working shift and the
  // start of the next (see lib/labor-rules.ts's minimumRestHours) — 15h,
  // computed from real shift timestamps including overnight shifts.
  minimum_rest_hours: number;
  // Confirmed: 42h is the maximum AVERAGE weekly working duration (see
  // lib/labor-rules.ts's maximumAverageWeeklyWorkingHours) — NOT a
  // Monday-Sunday calendar-week ceiling. Normal employee rosters are a
  // continuous rotation across week boundaries; a displayed WeeklyPlan
  // is only a 7-day view into it. See working_hours_reference_period_days
  // below and lib/planning/average-hours.ts for how (and whether) actual
  // compliance can currently be evaluated.
  maximum_average_weekly_working_hours: number;
  // NOT YET CONFIRMED. null = no reference period configured yet, which
  // means average-hours compliance is not currently evaluable — see
  // lib/planning/average-hours.ts's evaluateAverageWorkingHours. Do not
  // treat null as "assume 7 days."
  working_hours_reference_period_days: number | null;
  // NOT YET CONFIRMED, and a genuinely different concept from the 42h
  // ceiling above — a target/floor (how much an employee should be
  // scheduled to work), not a maximum. Confirmed as a PRINCIPLE (see
  // lib/labor-rules.ts's workingHoursObligationHours and
  // docs/known-limitations/roster-planning-vs-duty-allocation.md): an
  // employee's schedule is driven by their real working-hours
  // obligation, never purely by whether that day's flight demand
  // happens to justify rostering them. null = no real target/shape has
  // been confirmed yet, so no roster-generation logic may derive
  // demand-independent scheduling decisions from this value — see
  // lib/planning/roster-obligation.ts. Do not default this to
  // maximum_average_weekly_working_hours; that would silently repurpose
  // a confirmed ceiling as an unconfirmed floor.
  working_hours_obligation_hours: number | null;
  // DEPRECATED — superseded by checkin_demand_policy below, which
  // generalizes Check-in demand to every RAM flight (see
  // lib/planning/checkin-demand.ts). Kept only because some UI/demand-
  // forecast code paths outside the seeded RAM pipeline (the "Add Flight"
  // manual form) still read these two directly; the generated weekly plan
  // itself no longer uses them.
  baseline_checkin_requirement: number;
  overbooking_checkin_reinforcement: number;
  // Generalized Check-in demand model — applies to every atlas_managed
  // (RAM) flight, not one hardcoded flight id. See
  // lib/planning/checkin-demand.ts for the full model and its doc comment
  // on which values are confirmed vs prototype/configurable (currently:
  // ALL of them are prototype — none has been confirmed as real
  // management policy yet).
  checkin_demand_policy: import("./planning/checkin-demand").CheckinDemandPolicy;
  // The LIVE Check-in demand policy as of the 2026-09-21 zone-model
  // cutover — see lib/planning/checkin-zone-demand.ts. checkin_demand_policy
  // above is kept only because the old per-flight
  // computeGeneralizedCheckinRequirement/isCheckinApplicable functions
  // still reference its type; the live pipeline (generate-draft-plan.ts)
  // reads THIS field for actual Check-in demand/placement now. Same
  // unconfirmed-prototype status as its predecessor — see that file's doc
  // comment.
  zone_checkin_demand_policy: import("./planning/checkin-zone-demand").ZoneCheckinDemandPolicy;
  // Resolved labor-rule values (see lib/labor-rules.ts) — the single
  // source every generator/validator must read instead of hardcoding its
  // own copy of the confirmed OFF-day protections. normal_weekly_off_days
  // and max_consecutive_off_days govern ordinary weekly-roster generation
  // and validation AND are the same hard feasibility gate the Rotation
  // Feasibility Engine applies to foreign-team candidate rotations.
  // renfort_weekly_off_days is carried here purely for representability —
  // no automatic generation path reads it; renfort is only ever activated
  // by an explicit human management action.
  normal_weekly_off_days: number;
  max_consecutive_off_days: number;
  renfort_weekly_off_days: number;
  // NOT YET CONFIRMED — mirrors working_hours_reference_period_days'
  // "null means not configured" convention, but for the OBLIGATION
  // (target/floor) rather than the 42h ceiling: the number of days
  // `working_hours_obligation_hours` is defined over (e.g. a flat weekly
  // figure would be 7; an averaged figure over some longer window would
  // be that window's length). null means "no real horizon confirmed yet"
  // — lib/planning/roster-generation.ts must never guess one (e.g. by
  // defaulting to the displayed week's own length) while this stays null;
  // it only prorates a window's target once both this AND
  // working_hours_obligation_hours are non-null. See
  // docs/known-limitations/roster-planning-vs-duty-allocation.md.
  working_hours_obligation_reference_period_days: number | null;
  // Soft-objective weighting for scoreCandidates' fairness tie-break (see
  // lib/scoring.ts and lib/fairness-config.ts). Every weight defaults to
  // 0/neutral — a genuine no-op that reproduces today's candidate order
  // exactly — until a real weighting is confirmed; see
  // lib/fairness-config.ts's own doc comment for why this follows the
  // same LaborRuleSource "don't invent a coefficient" convention as
  // lib/labor-rules.ts, even though it isn't itself a LaborRules entry.
  fairness_weights: import("./fairness-config").FairnessWeights;
}

/**
 * PARALLEL to StaffingRequirement — a T1 Check-in ZONE's aggregate
 * required headcount for one day/time-window, never anchored to a single
 * flight (see supabase/migrations/0015_checkin_zones.sql's doc comment for
 * why this is a separate table/type rather than a retrofit of
 * StaffingRequirement). `zone` is one of lib/checkin-zones.ts's
 * CheckinZoneId values. `contributingFlightIds` is the real, normalized
 * relationship (a join table in persistence, a plain array once loaded
 * into memory) to every flight whose Check-in demand fed this
 * requirement's `required_headcount` — this is what Flight Coverage's
 * zone drill-down renders.
 */
export interface ZoneCheckinRequirement {
  id: string;
  plan_id: string;
  zone: import("./checkin-zones").CheckinZoneId;
  day_of_week: string;
  window_start: string; // "HH:mm"
  window_end: string; // "HH:mm"
  required_headcount: number;
  source: "automatic" | "manual";
  reasoning: string;
  contributingFlightIds: string[];
}

/** PARALLEL to Assignment — an employee covering a ZoneCheckinRequirement instead of a StaffingRequirement. Same source/created_by/assigned_at provenance convention as Assignment, so Draft/Published/human-modification/audit semantics generalize unchanged (see AssignmentSource). */
export interface ZoneCheckinAssignment {
  id: string;
  plan_id: string;
  zone_requirement_id: string;
  employee_id: string;
  // This employee's own real covered interval -- may be narrower than the
  // parent ZoneCheckinRequirement's window_start/window_end (see
  // supabase/migrations/0015_checkin_zones.sql's doc comment on this
  // column). Never assumed equal to the parent requirement's window.
  window_start: string;
  window_end: string;
  source: AssignmentSource;
  created_by: string | null;
  assigned_at: string;
}

export interface AgentScheduleEntry {
  employee: Employee;
  dayOff: boolean;
  // CONFIRMED — real Assignment rows.
  duties: { flightNumber: string; role: string; dayOfWeek: string }[];
  // PROPOSED — from the engine's generated draft plan (generateDraftWeeklyPlan),
  // not yet confirmed. Kept honestly separate, same pattern as
  // RosterRequirementView.proposedEmployees — never silently merged into `duties`.
  proposedDuties: { flightNumber: string; role: string; dayOfWeek: string }[];
  // The real day-by-day source of truth for the Agent Schedule weekly grid
  // — one entry per day of the week, derived from the SAME generated plan
  // as `duties`/`proposedDuties` above (never a second scheduling model).
  days: AgentDayEntry[];
  // Week-level plan issues for this employee that don't belong to one
  // specific day (currently only weekly_hours_violation).
  weeklyIssues: import("./planning/validation").PlanIssue[];
}

// A single flight duty on a specific day. "confirmed" = backed by a real
// Assignment row; "assigned" = ATLAS's own draft-plan assignment, not yet
// backed by one. Both are normal, current duties for this employee — this
// is no longer a proposed/confirmed (recommendation/approval) distinction,
// just a record of where the duty currently lives in the publish pipeline.
export interface AgentScheduleDuty {
  flightId: string;
  flightNumber: string;
  role: string;
  window: { start: string; end: string };
  status: "confirmed" | "assigned";
}

// One day of an employee's generated week. Deliberately NOT a single
// exclusive "day kind" — an employee can simultaneously have a shift, a
// foreign-company protected commitment, and one or more RAM duties on the
// same day. Each fact is its own field so the UI composes them rather than
// picking one label to represent the whole day.
/**
 * A T1 Check-in ZONE duty on a specific day -- rendered completely
 * differently from AgentScheduleDuty ("AT740 · Gate"): a zone duty shows
 * as "T1 Main Check-in · counters 30–76 · 05:45–08:30", never a flight
 * number, because a zone duty was never anchored to one specific flight
 * in the first place (see lib/checkin-zones.ts's module doc comment).
 * Optional on AgentDayEntry (default/undefined -> render as empty) so the
 * LIVE pre-persistence preview (weekly-plan-view.ts, not on the
 * production read path -- see persisted-plan-view.ts for the one that
 * actually populates this) never needs updating just to keep compiling.
 */
export interface AgentZoneDuty {
  zone: import("./checkin-zones").CheckinZoneId;
  window: { start: string; end: string };
  // "confirmed" = a real human Find Agent commitment (checkin_zone_assignments,
  // source: "human_modified"). "available" = DERIVED default T1 coverage —
  // this employee has no specific duty during this window while rostered
  // WORK, and this is the ordinary zone the demand-informed heuristic
  // attributes them to at that time (see
  // lib/planning/checkin-capacity-timeline.ts) — never itself a persisted
  // duty/commitment, hence a distinct status from "confirmed"/"assigned".
  // "assigned" is kept in the union only for backward-compatible display of
  // any pre-2026-09-23 persisted row; fresh generation never produces one
  // (see weekly-plan-service.ts's buildDraftPlanBundle doc comment).
  status: "confirmed" | "assigned" | "available";
}

export interface AgentDayEntry {
  dayOfWeek: string;
  status: "working" | "off";
  shiftCode: string | null; // the REAL effective code for this day (generated for flexible pool, actual roster entry otherwise) — never the employee's static shift_code
  shiftStart: string | null;
  shiftEnd: string | null;
  foreignCommitments: import("./foreign-company-window").ForeignCommitment[];
  duties: AgentScheduleDuty[];
  zoneDuties?: AgentZoneDuty[];
  issues: import("./planning/validation").PlanIssue[];
}
