export type RequirementSource = "fixed_rule" | "demand_forecast" | "company_config";
export type BookingPressure = "normal" | "elevated";
export type FlightStatus = "scheduled" | "delayed";
export type CandidateStatus = "recommended" | "flagged";
export type PlannedDutyStatus = "planned" | "reassigned";
export type OperatorType = "atlas_managed" | "self_managed";
export type RequirementCoverageStatus = "covered" | "gap" | "conflict" | "needs_configuration";

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
  destination_category: string | null; // e.g. "Europe/Schengen", "Long-haul" — RAM flights only
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
  assignedEmployees: Employee[];
  gap: number;
  coverageStatus: RequirementCoverageStatus;
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
  fairness_ceiling_hours: number;
  baseline_checkin_requirement: number;
  overbooking_checkin_reinforcement: number;
}

export interface AgentScheduleEntry {
  employee: Employee;
  dayOff: boolean;
  duties: { flightNumber: string; role: string; dayOfWeek: string }[];
}
