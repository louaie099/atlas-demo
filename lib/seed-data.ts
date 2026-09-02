import { Employee, Flight, Config } from "./types";

export const CONFIG: Config = {
  minimum_rest_hours: 10,
  fairness_ceiling_hours: 40,
  baseline_checkin_requirement: 4,
  overbooking_checkin_reinforcement: 2,
};

export const EMPLOYEES: Employee[] = [
  {
    id: "sara-bennis",
    name: "Sara Bennis",
    roles: ["Boarding", "Business Class"],
    shift_start: "14:00",
    shift_end: "22:00",
    rest_before_shift_hours: 12,
    weekly_hours: 24,
    is_duty_officer: false,
  },
  {
    id: "youssef-el-amrani",
    name: "Youssef El Amrani",
    roles: ["Boarding", "Profiling"],
    shift_start: "14:00",
    shift_end: "22:00",
    rest_before_shift_hours: 12,
    weekly_hours: 26,
    is_duty_officer: false,
  },
  {
    id: "nadia-ziani",
    name: "Nadia Ziani",
    roles: ["Boarding", "Transit"],
    shift_start: "10:00",
    shift_end: "18:00",
    rest_before_shift_hours: 11,
    weekly_hours: 22,
    is_duty_officer: false,
  },
  {
    id: "karim-idrissi",
    name: "Karim Idrissi",
    roles: ["Boarding"],
    shift_start: "06:00",
    shift_end: "14:00",
    rest_before_shift_hours: 10,
    weekly_hours: 38,
    is_duty_officer: false,
  },
  {
    id: "amina-fassi",
    name: "Amina Fassi",
    roles: ["Care Point", "Boarding"],
    shift_start: "14:00",
    shift_end: "22:00",
    rest_before_shift_hours: 13,
    weekly_hours: 20,
    is_duty_officer: false,
  },
  {
    id: "mohammed-alaoui",
    name: "Mohammed Alaoui",
    roles: ["Duty Officer"],
    shift_start: "06:00",
    shift_end: "18:00",
    rest_before_shift_hours: 12,
    weekly_hours: 30,
    is_duty_officer: true,
  },
  {
    id: "hicham-bouzid",
    name: "Hicham Bouzid",
    roles: ["Check-in/ACE"],
    shift_start: "06:00",
    shift_end: "14:00",
    rest_before_shift_hours: 11,
    weekly_hours: 30,
    is_duty_officer: false,
  },
  {
    id: "rania-toumi",
    name: "Rania Toumi",
    roles: ["Check-in/ACE"],
    shift_start: "06:00",
    shift_end: "14:00",
    rest_before_shift_hours: 12,
    weekly_hours: 18,
    is_duty_officer: false,
  },
];

export const FLIGHTS: Flight[] = [
  {
    id: "at201",
    flight_number: "AT201",
    airline: "Royal Air Maroc",
    route: "CMN → CDG",
    aircraft: "Boeing 737-800",
    scheduled_departure: "14:30",
    gate: "B12",
    boarding_window_start: "13:50",
    boarding_window_end: "14:20",
    status: "scheduled",
    booking_pressure: "normal",
  },
  {
    id: "at535",
    flight_number: "AT535",
    airline: "Royal Air Maroc",
    route: "CMN → ORY",
    aircraft: "Boeing 737-800",
    scheduled_departure: "09:00",
    gate: null,
    boarding_window_start: null,
    boarding_window_end: null,
    status: "scheduled",
    booking_pressure: "elevated",
  },
];

// Baseline Check-in/ACE staffing already covering AT535's 4-person baseline,
// represented as a count only (not individually named — not candidates).
export const AT535_BASELINE_ALREADY_STAFFED = 4;

// AT201's two initially-assigned Boarding agents.
export const INITIAL_AT201_ASSIGNEES = ["sara-bennis", "youssef-el-amrani"];

// Nadia's pre-planned duty that creates the live-ops conflict once AT201 is delayed.
export const INITIAL_PLANNED_DUTY = {
  employee_id: "nadia-ziani",
  task: "Care Point rotation",
  planned_start: "14:30",
};
