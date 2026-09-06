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
  off_days: string[]; // e.g. ["Thursday"] — days this employee is not working this week
  foreign_company_authorizations: string[]; // e.g. ["Qatar Airways"] — companies they're TRAINED/AUTHORIZED to work (capability). Does NOT mean currently placed there — that's what `assignment` represents. Being authorized never removes RAM availability outside an actual protected window (see foreign-company-window.ts).
  active: boolean; // workforce status — editable only by Administrators (see lib/roles.ts). An inactive employee is never a scoring candidate.
  // Foundation for day-by-day weekly planning: one entry per day of the
  // current week, each with its own shift code or "off" status. Currently
  // populated uniformly from shift_code/off_days above (today's Find Agent
  // logic doesn't read this yet) — the future Weekly Planning redesign is
  // what will actually vary this day-to-day (different codes per day,
  // mid-week status changes, etc.), not this step.
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
  day_of_week: string; // e.g. "Wednesday" — which day of the selected week
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

export interface Assignment {
  id: string;
  staffing_requirement_id: string;
  employee_id: string;
  assigned_at: string;
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
  minimum_rest_hours: number;
  // "unconfirmed" is a real, literal state (see lib/labor-rules.ts) — never
  // a guessed number. Code reading this must skip/disable the ceiling
  // check rather than compare against an invented value.
  fairness_ceiling_hours: number | "unconfirmed";
  baseline_checkin_requirement: number;
  overbooking_checkin_reinforcement: number;
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
export interface AgentDayEntry {
  dayOfWeek: string;
  status: "working" | "off";
  shiftCode: string | null; // the REAL effective code for this day (generated for flexible pool, actual roster entry otherwise) — never the employee's static shift_code
  shiftStart: string | null;
  shiftEnd: string | null;
  foreignCommitments: import("./foreign-company-window").ForeignCommitment[];
  duties: AgentScheduleDuty[];
  issues: import("./planning/validation").PlanIssue[];
}
