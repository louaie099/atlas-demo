import { Employee, Flight, Config, WeeklyShiftEntry } from "./types";
import { generateEmployees } from "./employee-generator";
import { generateWeeklyFlights } from "./flight-generator";
import { getShiftTimesAs, buildUniformWeeklySchedule } from "./shift-templates";
import { CONFIGURED_COMPANIES } from "./company-config";
import { planForeignCompanyDay } from "./foreign-shift-planning";
import { buildStaggeredOffDays, offDaysCountForShift } from "./roster-generation";

export const CONFIG: Config = {
  minimum_rest_hours: 10,
  fairness_ceiling_hours: 40,
  baseline_checkin_requirement: 4,
  overbooking_checkin_reinforcement: 2,
};

export const CURRENT_WEEK_LABEL = "Week of Mon, Sep 1 2026";
export const DAYS_WITH_DATA = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export const DEMO_TODAY = "Wednesday";

const SCRIPTED_OFF_DAY_POOL = DAYS_WITH_DATA.filter((d) => d !== DEMO_TODAY);
function scriptedOffDays(shiftCode: string, employeeIndex: number): string[] {
  return buildStaggeredOffDays(employeeIndex, offDaysCountForShift(shiftCode, CONFIG.fairness_ceiling_hours), SCRIPTED_OFF_DAY_POOL);
}

export const SCRIPTED_EMPLOYEES: Omit<Employee, "weekly_shifts">[] = [
  {
    id: "sara-bennis",
    name: "Sara Bennis",
    skills: ["Boarding", "Business Class"],
    assignment: "General T1 Pool",
    shift_code: "AP01",
    ...getShiftTimesAs("AP01"),
    rest_before_shift_hours: 12,
    weekly_hours: 24,
    is_duty_officer: false,
    off_days: scriptedOffDays("AP01", 0),
    foreign_company_authorizations: [],
    active: true,
  },
  {
    id: "youssef-el-amrani",
    name: "Youssef El Amrani",
    skills: ["Boarding", "Profiling"],
    assignment: "General T1 Pool",
    shift_code: "AP02",
    ...getShiftTimesAs("AP02"),
    rest_before_shift_hours: 12,
    weekly_hours: 26,
    is_duty_officer: false,
    off_days: scriptedOffDays("AP02", 1),
    foreign_company_authorizations: [],
    active: true,
  },
  {
    id: "nadia-ziani",
    name: "Nadia Ziani",
    skills: ["Boarding"],
    assignment: "General T1 Pool",
    shift_code: "NR02",
    ...getShiftTimesAs("NR02"),
    rest_before_shift_hours: 11,
    weekly_hours: 22,
    is_duty_officer: false,
    off_days: scriptedOffDays("NR02", 2),
    foreign_company_authorizations: [],
    active: true,
  },
  {
    id: "karim-idrissi",
    name: "Karim Idrissi",
    skills: ["Boarding"],
    assignment: "General T1 Pool",
    shift_code: null,
    shift_start: "06:00",
    shift_end: "14:00",
    rest_before_shift_hours: 10,
    weekly_hours: 38,
    is_duty_officer: false,
    off_days: ["Saturday", "Sunday"],
    foreign_company_authorizations: [],
    active: true,
  },
  {
    id: "amina-fassi",
    name: "Amina Fassi",
    skills: ["Care Point", "Boarding"],
    assignment: "General T1 Pool",
    shift_code: "AP01",
    ...getShiftTimesAs("AP01"),
    rest_before_shift_hours: 13,
    weekly_hours: 20,
    is_duty_officer: false,
    off_days: scriptedOffDays("AP01", 3),
    foreign_company_authorizations: [],
    active: true,
  },
  {
    id: "mohammed-alaoui",
    name: "Mohammed Alaoui",
    skills: ["Boarding"],
    assignment: "Duty Officers",
    shift_code: "JR01",
    ...getShiftTimesAs("JR01"),
    rest_before_shift_hours: 12,
    weekly_hours: 30,
    is_duty_officer: true,
    off_days: scriptedOffDays("JR01", 4),
    foreign_company_authorizations: [],
    active: true,
  },
  {
    id: "hicham-bouzid",
    name: "Hicham Bouzid",
    skills: ["Check-in"],
    assignment: "General T1 Pool",
    shift_code: "MT01",
    ...getShiftTimesAs("MT01"),
    rest_before_shift_hours: 11,
    weekly_hours: 30,
    is_duty_officer: false,
    off_days: scriptedOffDays("MT01", 5),
    foreign_company_authorizations: [],
    active: true,
  },
  {
    id: "rania-toumi",
    name: "Rania Toumi",
    skills: ["Check-in"],
    assignment: "General T1 Pool",
    shift_code: "MT02",
    ...getShiftTimesAs("MT02"),
    rest_before_shift_hours: 12,
    weekly_hours: 18,
    is_duty_officer: false,
    off_days: scriptedOffDays("MT02", 6),
    foreign_company_authorizations: [],
    active: true,
  },
];

const ROTATING_SHIFT_PATTERN_A: { day: string; code: string | null }[] = [
  { day: "Monday", code: "MT01" },
  { day: "Tuesday", code: "MT01" },
  { day: "Wednesday", code: "MT01" },
  { day: "Thursday", code: "OFF" },
  { day: "Friday", code: "AP01" },
  { day: "Saturday", code: "OFF" },
  { day: "Sunday", code: "OFF" },
];

export const ROTATING_SHIFT_EMPLOYEES: Omit<Employee, "weekly_shifts">[] = [
  {
    id: "rotation-example-gate",
    name: "Amine Sqalli",
    skills: ["Gate"],
    assignment: "General T1 Pool",
    shift_code: "MT01",
    ...getShiftTimesAs("MT01"),
    rest_before_shift_hours: 11,
    weekly_hours: 24,
    is_duty_officer: false,
    off_days: ["Thursday"],
    foreign_company_authorizations: [],
    active: true,
  },
];

export const SCRIPTED_FLIGHTS: Flight[] = [
  {
    id: "at201",
    flight_number: "AT201",
    airline: "Royal Air Maroc",
    route: "CMN -> CDG",
    origin: "CMN",
    destination: "CDG",
    aircraft: "Boeing 737-800",
    equipment_code: null,
    registration: null,
    callsign: null,
    terminal: "T1",
    scheduled_departure: "14:30",
    scheduled_arrival: null,
    gate: "B12",
    boarding_window_start: "13:50",
    boarding_window_end: "14:20",
    status: "scheduled",
    booking_pressure: "normal",
    day_of_week: "Wednesday",
    operator_type: "atlas_managed",
    destination_category: "Europe/Schengen",
  },
  {
    id: "at535",
    flight_number: "AT535",
    airline: "Royal Air Maroc",
    route: "CMN -> ORY",
    origin: "CMN",
    destination: "ORY",
    aircraft: "Boeing 737-800",
    equipment_code: null,
    registration: null,
    callsign: null,
    terminal: "T1",
    scheduled_departure: "09:00",
    scheduled_arrival: null,
    gate: null,
    boarding_window_start: null,
    boarding_window_end: null,
    status: "scheduled",
    booking_pressure: "elevated",
    day_of_week: "Wednesday",
    operator_type: "atlas_managed",
    destination_category: "Europe/Schengen",
  },
];

export const FLIGHTS: Flight[] = [...SCRIPTED_FLIGHTS, ...generateWeeklyFlights()];

function applyForeignCompanyRoster(employee: Employee): Employee {
  if (!CONFIGURED_COMPANIES.includes(employee.assignment)) return employee;

  const weekly_shifts: WeeklyShiftEntry[] = employee.weekly_shifts.map((entry) => {
    if (entry.status === "off") return entry;

    const plan = planForeignCompanyDay(employee.assignment, entry.day_of_week, FLIGHTS);
    if (!plan || !plan.shiftCode) return entry;

    return { ...entry, shift_code: plan.shiftCode, status: "working" };
  });

  return { ...employee, weekly_shifts };
}

export const EMPLOYEES: Employee[] = [
  ...SCRIPTED_EMPLOYEES.map((e) => ({
    ...e,
    weekly_shifts: buildUniformWeeklySchedule(e.shift_code, e.off_days, DAYS_WITH_DATA),
  })),
  ...generateEmployees(SCRIPTED_EMPLOYEES.length).map((e) => ({
    ...e,
    weekly_shifts: buildUniformWeeklySchedule(e.shift_code, e.off_days, DAYS_WITH_DATA),
  })),
  ...ROTATING_SHIFT_EMPLOYEES.map((e) => ({
    ...e,
    weekly_shifts: DAYS_WITH_DATA.map((day) => {
      const entry = ROTATING_SHIFT_PATTERN_A.find((p) => p.day === day)!;
      return {
        day_of_week: day,
        shift_code: entry.code === "OFF" ? null : entry.code,
        status: (entry.code === "OFF" ? "off" : "working") as "off" | "working",
      };
    }),
  })),
].map(applyForeignCompanyRoster);

export const AT535_BASELINE_ALREADY_STAFFED = 4;

export const INITIAL_AT201_ASSIGNEES = ["sara-bennis", "youssef-el-amrani"];

export const INITIAL_PLANNED_DUTY = {
  employee_id: "nadia-ziani",
  task: "Care Point rotation",
  planned_start: "14:30",
};
