export type RequirementSource = "fixed_rule" | "demand_forecast";
export type BookingPressure = "normal" | "elevated";
export type FlightStatus = "scheduled" | "delayed";
export type CandidateStatus = "recommended" | "flagged";
export type PlannedDutyStatus = "planned" | "reassigned";

export interface Employee {
  id: string;
  name: string;
  roles: string[];
  shift_start: string; // "HH:mm"
  shift_end: string; // "HH:mm"
  rest_before_shift_hours: number;
  weekly_hours: number;
  is_duty_officer: boolean;
}

export interface Flight {
  id: string;
  flight_number: string;
  airline: string;
  route: string;
  aircraft: string;
  scheduled_departure: string; // "HH:mm"
  gate: string | null;
  boarding_window_start: string | null;
  boarding_window_end: string | null;
  status: FlightStatus;
  booking_pressure: BookingPressure;
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
