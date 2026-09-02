import { Employee } from "./types";
import { getShiftTimesAs } from "./shift-templates";

// Synthetic name pools — clearly generated, not real personnel. Combined
// deterministically by index (never Math.random()) so the dataset is
// reproducible across every reset.
const FIRST_NAMES = [
  "Hamza", "Salma", "Othmane", "Ghita", "Anas", "Meryem", "Yassine", "Imane",
  "Reda", "Zineb", "Ayoub", "Sanaa", "Bilal", "Ikram", "Amine", "Loubna",
  "Soufiane", "Hajar", "Marouane", "Fadwa", "Khalid", "Widad", "Tarik", "Nawal",
  "Ismail", "Chaimae", "Younes", "Kenza", "Adil", "Basma", "Mehdi", "Siham",
];
const LAST_NAMES = [
  "Ouazzani", "Benali", "Chafik", "Idrissi", "Bouzid", "Lahlou", "Fassi", "Rifai",
  "Sqalli", "Amrani", "Berrada", "Kabbaj", "Naciri", "Tazi", "Cherkaoui", "Alami",
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
  roles: string[];
  default_team: string;
  shift_code: string; // authoritative code from shift-templates.ts
  rest_before_shift_hours: number;
  weekly_hours: number;
  foreign_company_authorizations?: string[];
  off_days?: string[];
}

/**
 * Category definitions matching the requested distribution. Shift codes
 * are drawn from the authoritative catalog (lib/shift-templates.ts) —
 * chosen per category for plausibility (e.g. Leaders/Duty Officers get
 * JR/NT codes, per the confirmed "fixed JR/NT-type planning" rule), not
 * invented times. Rest/weekly-hours values are deliberately varied to
 * demonstrate fairness/rest constraints across categories, not just the
 * original scripted employees.
 */
const CATEGORIES: GenSpec[] = [
  // Newer T1 ACEs — basic qualifications only.
  { count: 6, roles: ["Check-in/ACE", "Weight Control"], default_team: "General T1 Pool", shift_code: "NR01", rest_before_shift_hours: 12, weekly_hours: 16 },
  // Intermediate ACEs — Boarding + Gate or Care Point.
  { count: 5, roles: ["Boarding", "Gate"], default_team: "General T1 Pool", shift_code: "AP01", rest_before_shift_hours: 11, weekly_hours: 24 },
  // Experienced, multi-qualified ACEs — weekly hours intentionally near the
  // fairness ceiling, demonstrating a genuine fairness constraint beyond Karim.
  { count: 4, roles: ["Boarding", "Gate", "Care Point", "Check-in/ACE"], default_team: "General T1 Pool", shift_code: "NR02", rest_before_shift_hours: 10, weekly_hours: 36 },
  // Dedicated Transit agents — strictly unavailable outside Transit for the full shift.
  { count: 4, roles: ["Transit"], default_team: "Transit", shift_code: "MT01", rest_before_shift_hours: 11, weekly_hours: 28 },
  // Profiling team — some also hold other qualifications.
  { count: 3, roles: ["Profiling", "Boarding"], default_team: "Profiling", shift_code: "NR02", rest_before_shift_hours: 11, weekly_hours: 22 },
  // Mesure team — some also hold Profiling. Rest hours intentionally below
  // the minimum for this category, demonstrating a rest constraint within
  // a specialized team, not only the General T1 pool.
  { count: 3, roles: ["Mesure", "Profiling"], default_team: "Mesure", shift_code: "MT02", rest_before_shift_hours: 9, weekly_hours: 30 },
  // Caisse/BCB — fixed planning, excluded from general allocation.
  { count: 2, roles: ["Caisse/BCB"], default_team: "Caisse/BCB", shift_code: "NR01", rest_before_shift_hours: 12, weekly_hours: 20 },
  // Service Plus — T1-based premium/VIP activity. No detailed operational
  // rules were provided, so this is qualification/team only.
  { count: 2, roles: ["Service Plus"], default_team: "Service Plus", shift_code: "AP02", rest_before_shift_hours: 12, weekly_hours: 18 },
  // Leaders — confirmed fixed JR-type planning.
  { count: 2, roles: ["Leader"], default_team: "Leaders", shift_code: "JR02", rest_before_shift_hours: 12, weekly_hours: 32 },
  // One additional Duty Officer alongside the existing scripted one —
  // confirmed fixed NT-type planning (night coverage).
  { count: 1, roles: ["Duty Officer"], default_team: "Duty Officers", shift_code: "NT01", rest_before_shift_hours: 12, weekly_hours: 30 },
  // ACEs holding foreign-company authorizations, layered on top of a
  // normal General T1 Pool team — NOT a separate team. They work La RAM
  // whenever outside their protected foreign-company commitment window
  // (see foreign-company-window.ts). Shift code is an ordinary General T1
  // pattern — foreign authorization doesn't require a special shift.
  { count: 3, roles: ["Boarding", "Ramp Team"], default_team: "General T1 Pool", shift_code: "NR01", rest_before_shift_hours: 11, weekly_hours: 26, foreign_company_authorizations: ["Qatar Airways", "Emirates"] },
];

export function generateEmployees(startIndex = 0): Omit<Employee, "weekly_shifts">[] {
  const employees: Omit<Employee, "weekly_shifts">[] = [];
  let i = startIndex;

  for (const spec of CATEGORIES) {
    for (let n = 0; n < spec.count; n++) {
      const name = nameForIndex(i);
      const { shift_start, shift_end } = getShiftTimesAs(spec.shift_code);
      employees.push({
        id: idForName(name, i),
        name,
        roles: spec.roles,
        default_team: spec.default_team,
        shift_code: spec.shift_code,
        shift_start,
        shift_end,
        rest_before_shift_hours: spec.rest_before_shift_hours,
        weekly_hours: spec.weekly_hours,
        is_duty_officer: spec.default_team === "Duty Officers",
        off_days: spec.off_days ?? [],
        foreign_company_authorizations: spec.foreign_company_authorizations ?? [],
      });
      i++;
    }
  }

  return employees;
}
