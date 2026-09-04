import { Employee } from "./types";
import { getShiftTimesAs } from "./shift-templates";
import { buildStaggeredOffDays, offDaysCountForShift } from "./roster-generation";
import { companyOperatingDays } from "./flight-generator";

const ALL_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const FAIRNESS_CEILING_HOURS = 40;

const FIRST_NAMES = [
  "Hamza", "Salma", "Othmane", "Ghita", "Anas", "Meryem", "Yassine", "Imane",
  "Reda", "Zineb", "Ayoub", "Sanaa", "Bilal", "Ikram", "Amine", "Loubna",
  "Soufiane", "Hajar", "Marouane", "Fadwa", "Khalid", "Widad", "Tarik", "Nawal",
  "Ismail", "Chaimae", "Younes", "Kenza", "Adil", "Basma", "Mehdi", "Siham",
  "Rachid", "Latifa", "Karim", "Malika", "Said", "Naima", "Hassan", "Souad",
  "Aziz", "Fatima", "Jamal", "Amal", "Nabil", "Rajae", "Samir", "Houda",
  "Omar", "Btissam", "Driss", "Karima", "Mounir", "Assia", "Zakaria", "Wafaa",
  "Abderrahim", "Sara", "Noureddine", "Meriem",
];
const LAST_NAMES = [
  "Ouazzani", "Benali", "Chafik", "Idrissi", "Bouzid", "Lahlou", "Fassi", "Rifai",
  "Sqalli", "Amrani", "Berrada", "Kabbaj", "Naciri", "Tazi", "Cherkaoui", "Alami",
  "Bennani", "Zerouali", "Guessous", "Sbai", "Tahiri", "Belkadi", "Filali", "Skalli",
];

function nameForIndex(i: number): string {
  const first = FIRST_NAMES[i % FIRST_NAMES.length];
  const last = LAST_NAMES[Math.floor(i / FIRST_NAMES.length) % LAST_NAMES.length];
  return `${first} ${last}`;
}

function idForName(name: string, suffix: number): string {
  return `${name.toLowerCase().replace(/\s+/g, "-")}-${suffix}`;
}

interface GenSpec {
  count: number;
  skills: string[];
  assignment: string;
  shift_code: string;
  rest_before_shift_hours: number;
  weekly_hours: number;
  foreign_company_authorizations?: string[];
  keepWednesdayWorking?: boolean;
}

const CATEGORIES: GenSpec[] = [
  { count: 20, skills: ["Check-in", "Weight Control"], assignment: "General T1 Pool", shift_code: "NR01", rest_before_shift_hours: 12, weekly_hours: 16, keepWednesdayWorking: true },
  { count: 20, skills: ["Check-in", "Weight Control"], assignment: "General T1 Pool", shift_code: "MT01", rest_before_shift_hours: 12, weekly_hours: 18, keepWednesdayWorking: true },
  { count: 20, skills: ["Boarding", "Gate"], assignment: "General T1 Pool", shift_code: "AP01", rest_before_shift_hours: 11, weekly_hours: 24, keepWednesdayWorking: true },
  { count: 16, skills: ["Gate", "Care Point", "Check-in"], assignment: "General T1 Pool", shift_code: "AP02", rest_before_shift_hours: 11, weekly_hours: 22, keepWednesdayWorking: true },
  { count: 10, skills: ["Boarding", "Gate", "Care Point", "Check-in"], assignment: "General T1 Pool", shift_code: "NR02", rest_before_shift_hours: 10, weekly_hours: 36, keepWednesdayWorking: true },
  { count: 10, skills: ["Boarding", "Gate", "Care Point", "Check-in"], assignment: "General T1 Pool", shift_code: "JR01", rest_before_shift_hours: 10, weekly_hours: 34, keepWednesdayWorking: true },
  { count: 8, skills: ["Transit"], assignment: "Transit", shift_code: "MT01", rest_before_shift_hours: 11, weekly_hours: 28 },
  { count: 6, skills: ["Transit"], assignment: "Transit", shift_code: "AP01", rest_before_shift_hours: 11, weekly_hours: 26 },
  { count: 7, skills: ["Profiling"], assignment: "Profiling", shift_code: "NR02", rest_before_shift_hours: 11, weekly_hours: 22, keepWednesdayWorking: true },
  { count: 5, skills: ["Profiling", "Boarding"], assignment: "Profiling", shift_code: "AP02", rest_before_shift_hours: 11, weekly_hours: 24, keepWednesdayWorking: true },
  { count: 8, skills: ["Mesure"], assignment: "Mesure", shift_code: "MT02", rest_before_shift_hours: 9, weekly_hours: 30 },
  { count: 4, skills: ["Mesure", "Profiling"], assignment: "Mesure", shift_code: "NR01", rest_before_shift_hours: 11, weekly_hours: 24, keepWednesdayWorking: true },
  { count: 6, skills: ["Caisse/BCB"], assignment: "Caisse/BCB", shift_code: "NR01", rest_before_shift_hours: 12, weekly_hours: 20 },
  { count: 6, skills: ["Weight Control"], assignment: "Baggage Claim", shift_code: "NR01", rest_before_shift_hours: 11, weekly_hours: 20 },
  { count: 6, skills: ["Service Plus"], assignment: "Service Plus", shift_code: "AP02", rest_before_shift_hours: 12, weekly_hours: 18, keepWednesdayWorking: true },
  { count: 5, skills: ["Boarding"], assignment: "Leaders", shift_code: "JR02", rest_before_shift_hours: 12, weekly_hours: 32 },
  { count: 4, skills: ["Boarding"], assignment: "Duty Officers", shift_code: "NT01", rest_before_shift_hours: 12, weekly_hours: 30, keepWednesdayWorking: true },
];

const FOREIGN_GROUPS: GenSpec[] = [
  { count: 9, skills: ["Boarding", "Ramp Team"], assignment: "Emirates", shift_code: "NR01", rest_before_shift_hours: 11, weekly_hours: 26, foreign_company_authorizations: ["Emirates", "Etihad"], keepWednesdayWorking: true },
  { count: 7, skills: ["Boarding", "Ramp Team"], assignment: "Qatar Airways", shift_code: "NR01", rest_before_shift_hours: 12, weekly_hours: 24, foreign_company_authorizations: ["Qatar Airways", "Gulf Air"], keepWednesdayWorking: true },
  { count: 6, skills: ["Boarding", "Ramp Team"], assignment: "Gulf Air", shift_code: "MT02", rest_before_shift_hours: 11, weekly_hours: 25, foreign_company_authorizations: ["Gulf Air"], keepWednesdayWorking: true },
  { count: 5, skills: ["Boarding", "Ramp Team"], assignment: "Etihad", shift_code: "NR02", rest_before_shift_hours: 12, weekly_hours: 23, foreign_company_authorizations: ["Etihad", "Emirates"], keepWednesdayWorking: true },
  { count: 5, skills: ["Boarding", "Ramp Team"], assignment: "Air France", shift_code: "AP01", rest_before_shift_hours: 12, weekly_hours: 24, foreign_company_authorizations: ["Air France"], keepWednesdayWorking: true },
  { count: 4, skills: ["Boarding", "Ramp Team"], assignment: "General T1 Pool", shift_code: "NR01", rest_before_shift_hours: 11, weekly_hours: 22, foreign_company_authorizations: ["Air France", "Qatar Airways"] },
];

function preferredOffDaysFor(assignment: string): string[] | undefined {
  const flightDays = companyOperatingDays(assignment);
  if (flightDays.length === 0) return undefined;
  const nonFlightDays = ALL_DAYS.filter((d) => !flightDays.includes(d));
  return nonFlightDays.length > 0 ? nonFlightDays : undefined;
}

export function generateEmployees(startIndex = 0): Omit<Employee, "weekly_shifts">[] {
  const employees: Omit<Employee, "weekly_shifts">[] = [];
  let i = startIndex;

  for (const spec of [...CATEGORIES, ...FOREIGN_GROUPS]) {
    const offDaysCount = offDaysCountForShift(spec.shift_code, FAIRNESS_CEILING_HOURS);
    const candidatePool = spec.keepWednesdayWorking ? ALL_DAYS.filter((d) => d !== "Wednesday") : ALL_DAYS;
    const preferredOffDays = preferredOffDaysFor(spec.assignment);

    for (let n = 0; n < spec.count; n++) {
      const name = nameForIndex(i);
      const { shift_start, shift_end } = getShiftTimesAs(spec.shift_code);
      const off_days = buildStaggeredOffDays(n, offDaysCount, candidatePool, preferredOffDays);
      employees.push({
        id: idForName(name, i),
        name,
        skills: spec.skills,
        assignment: spec.assignment,
        shift_code: spec.shift_code,
        shift_start,
        shift_end,
        rest_before_shift_hours: spec.rest_before_shift_hours,
        weekly_hours: spec.weekly_hours,
        is_duty_officer: spec.assignment === "Duty Officers",
        off_days,
        foreign_company_authorizations: spec.foreign_company_authorizations ?? [],
        active: true,
      });
      i++;
    }
  }

  return employees;
}
