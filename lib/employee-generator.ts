import { Employee } from "./types";
import { getShiftTimesAs } from "./shift-templates";

// Synthetic name pools — clearly generated, not real personnel. Combined
// deterministically by index (never Math.random()) so the dataset is
// reproducible across every reset, at any scale.
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
  assignment: string; // internal RAM service (see teams.ts) OR a foreign company name (see company-config.ts)
  shift_code: string; // authoritative code from shift-templates.ts
  rest_before_shift_hours: number;
  weekly_hours: number;
  foreign_company_authorizations?: string[];
  off_days?: string[];
  // Rotates a pool of days across the members of this category (person 0
  // gets offDayRotation[0], person 1 gets offDayRotation[1 % length],
  // etc.) so a whole team isn't off on the same day at once, and so 200
  // employees doesn't mean 200 people available every single day.
  // Categories whose skills are queried by a live requirement today
  // (Boarding, Check-in) deliberately exclude "Wednesday" from their
  // rotation — scoring.ts doesn't yet check per-day off-status, so
  // marking someone off on the one day live scoring runs against would
  // create a new, avoidable inconsistency rather than fix one.
  offDayRotation?: string[];
}

/**
 * ~200-employee workforce (191 generated + 9 protected scripted/example
 * employees), distributed deterministically by weighted category, not by
 * duplication or uncontrolled randomness. Every count below is an
 * authored choice; nameForIndex/idForName are index-based, never
 * Math.random(), so Reset Demo always reproduces exactly this workforce.
 *
 * Qualification corrections made during this expansion (previous rounds
 * had drifted from the confirmed vocabulary):
 *  - Transit-assigned employees now hold the "Transit" SKILL (it's a
 *    real confirmed qualification, not just a team name) instead of the
 *    removed "Arrivals" placeholder.
 *  - Profiling-assigned employees now hold "Profiling" as a skill
 *    (previously held "Boarding" only, which didn't reflect their
 *    specialization at all).
 *  - Mesure-assigned employees now hold "Mesure" (previously "Gate"),
 *    with a subset also holding "Profiling" per the explicit instruction
 *    that some Mesure employees are Profiling-qualified too.
 *  - Caisse/BCB and Service Plus employees now hold the matching
 *    confirmed specialized skill, instead of a generic "Check-in"/
 *    "Boarding" placeholder.
 *  - "Baggage Claim" has NO confirmed dedicated skill in the current
 *    ATLAS vocabulary (only Core/Airside/Specialized are confirmed, and
 *    Baggage Claim isn't in any of them) — these employees are given
 *    "Weight Control" as the closest defensible baseline qualification,
 *    documented here rather than inventing a new skill category.
 *  - "Ramp Team" is kept ONLY for foreign-company-assigned employees —
 *    not a stray legacy skill, but the literal StaffingRequirement role
 *    name used by company-config.ts. Removing it would make these
 *    employees structurally unable to ever be found for their own
 *    company's flights.
 */
const CATEGORIES: GenSpec[] = [
  // ---- General T1 Pool (~96) — the flexible, unrestricted RAM ACE pool ----
  // Newer T1 ACEs — basic skills only. Split into two shift patterns for
  // day-to-day variety. Holds Check-in (queried live) — no Wednesday off.
  { count: 20, skills: ["Check-in", "Weight Control"], assignment: "General T1 Pool", shift_code: "NR01", rest_before_shift_hours: 12, weekly_hours: 16, offDayRotation: ["Monday", "Tuesday", "Thursday", "Friday", "Saturday", "Sunday"] },
  { count: 20, skills: ["Check-in", "Weight Control"], assignment: "General T1 Pool", shift_code: "MT01", rest_before_shift_hours: 12, weekly_hours: 18, offDayRotation: ["Tuesday", "Thursday", "Friday", "Saturday", "Sunday", "Monday"] },
  // Intermediate ACEs — Boarding + Gate. Holds Boarding — no Wednesday.
  { count: 20, skills: ["Boarding", "Gate"], assignment: "General T1 Pool", shift_code: "AP01", rest_before_shift_hours: 11, weekly_hours: 24, offDayRotation: ["Monday", "Tuesday", "Thursday", "Friday", "Saturday"] },
  // Intermediate ACEs — Gate + Care Point + Check-in.
  { count: 16, skills: ["Gate", "Care Point", "Check-in"], assignment: "General T1 Pool", shift_code: "AP02", rest_before_shift_hours: 11, weekly_hours: 22, offDayRotation: ["Monday", "Thursday", "Friday", "Saturday", "Sunday"] },
  // Experienced, multi-skilled ACEs — weekly hours intentionally near the
  // fairness ceiling, demonstrating a genuine fairness constraint beyond
  // Karim. Holds Boarding/Check-in — no Wednesday.
  { count: 10, skills: ["Boarding", "Gate", "Care Point", "Check-in"], assignment: "General T1 Pool", shift_code: "NR02", rest_before_shift_hours: 10, weekly_hours: 36, offDayRotation: ["Monday", "Tuesday", "Thursday", "Friday"] },
  { count: 10, skills: ["Boarding", "Gate", "Care Point", "Check-in"], assignment: "General T1 Pool", shift_code: "JR01", rest_before_shift_hours: 10, weekly_hours: 34, offDayRotation: ["Tuesday", "Thursday", "Friday"] },

  // ---- Specialized/fixed teams ----
  // Transit — committed for the full shift once on it. Skill is the
  // confirmed "Transit" qualification, not the removed "Arrivals". Split
  // into two shift patterns; safe to include Wednesday since Transit
  // isn't queried by any live Find-Agent role.
  { count: 8, skills: ["Transit"], assignment: "Transit", shift_code: "MT01", rest_before_shift_hours: 11, weekly_hours: 28, offDayRotation: ["Monday", "Wednesday", "Friday", "Sunday"] },
  { count: 6, skills: ["Transit"], assignment: "Transit", shift_code: "AP01", rest_before_shift_hours: 11, weekly_hours: 26, offDayRotation: ["Tuesday", "Wednesday", "Saturday"] },
  // Profiling — document verification. Real Profiling skill, some also Boarding.
  { count: 7, skills: ["Profiling"], assignment: "Profiling", shift_code: "NR02", rest_before_shift_hours: 11, weekly_hours: 22, offDayRotation: ["Monday", "Thursday", "Saturday"] },
  { count: 5, skills: ["Profiling", "Boarding"], assignment: "Profiling", shift_code: "AP02", rest_before_shift_hours: 11, weekly_hours: 24, offDayRotation: ["Tuesday", "Friday"] },
  // Mesure — carry-on inspection at the gate. Real Mesure skill; a subset
  // also Profiling-qualified, per the explicit instruction. Rest hours
  // intentionally tight for one sub-group, demonstrating a rest
  // constraint within a specialized assignment, not only General T1.
  { count: 8, skills: ["Mesure"], assignment: "Mesure", shift_code: "MT02", rest_before_shift_hours: 9, weekly_hours: 30, offDayRotation: ["Wednesday", "Friday", "Sunday"] },
  { count: 4, skills: ["Mesure", "Profiling"], assignment: "Mesure", shift_code: "NR01", rest_before_shift_hours: 11, weekly_hours: 24, offDayRotation: ["Monday", "Thursday"] },
  // Caisse/BCB — the payment desk. Fixed planning, excluded from general
  // allocation regardless of off-status.
  { count: 6, skills: ["Caisse/BCB"], assignment: "Caisse/BCB", shift_code: "NR01", rest_before_shift_hours: 12, weekly_hours: 20, offDayRotation: ["Wednesday", "Monday", "Friday"] },
  // Baggage Claim — no confirmed dedicated skill exists yet (see module
  // comment); "Weight Control" used as the closest defensible baseline.
  { count: 6, skills: ["Weight Control"], assignment: "Baggage Claim", shift_code: "NR01", rest_before_shift_hours: 11, weekly_hours: 20, offDayRotation: ["Wednesday", "Saturday", "Tuesday"] },
  // Service Plus — T1-based premium/VIP/business-class/lounge activity.
  { count: 6, skills: ["Service Plus"], assignment: "Service Plus", shift_code: "AP02", rest_before_shift_hours: 12, weekly_hours: 18, offDayRotation: ["Tuesday", "Friday", "Sunday"] },
  // Leaders — confirmed fixed JR-type planning, excluded from general
  // allocation regardless of off-status.
  { count: 5, skills: ["Boarding"], assignment: "Leaders", shift_code: "JR02", rest_before_shift_hours: 12, weekly_hours: 32, offDayRotation: ["Wednesday", "Thursday"] },
  // Duty Officers — confirmed fixed NT/JR-type planning (night/day
  // coverage). Kept off Wednesday only so the narrative (Mohammed Alaoui
  // approving on Wednesday) doesn't read oddly next to others being off
  // the same day.
  { count: 4, skills: ["Boarding"], assignment: "Duty Officers", shift_code: "NT01", rest_before_shift_hours: 12, weekly_hours: 30, offDayRotation: ["Saturday", "Sunday"] },
];

/**
 * Foreign-company groups — persistent assignment (not re-decided daily),
 * per the explicit domain rule. Realistic group sizes per configured
 * carrier. Their daily roster is derived from each company's actual
 * flight schedule by the planning pipeline already built
 * (lib/foreign-shift-planning.ts) — nothing about scheduling changes
 * here, only headcount and distribution. "Ramp Team" is kept as a skill
 * specifically because it's the literal role name company_config
 * requirements use (see module comment above) — not a stray legacy
 * qualifier.
 */
const FOREIGN_GROUPS: GenSpec[] = [
  { count: 9, skills: ["Boarding", "Ramp Team"], assignment: "Emirates", shift_code: "NR01", rest_before_shift_hours: 11, weekly_hours: 26, foreign_company_authorizations: ["Emirates", "Etihad"], offDayRotation: ["Tuesday", "Thursday", "Sunday"] },
  { count: 7, skills: ["Boarding", "Ramp Team"], assignment: "Qatar Airways", shift_code: "NR01", rest_before_shift_hours: 12, weekly_hours: 24, foreign_company_authorizations: ["Qatar Airways", "Gulf Air"], offDayRotation: ["Saturday", "Monday"] },
  { count: 6, skills: ["Boarding", "Ramp Team"], assignment: "Gulf Air", shift_code: "MT02", rest_before_shift_hours: 11, weekly_hours: 25, foreign_company_authorizations: ["Gulf Air"], offDayRotation: ["Friday", "Sunday"] },
  { count: 5, skills: ["Boarding", "Ramp Team"], assignment: "Etihad", shift_code: "NR02", rest_before_shift_hours: 12, weekly_hours: 23, foreign_company_authorizations: ["Etihad", "Emirates"], offDayRotation: ["Monday", "Thursday"] },
  { count: 5, skills: ["Boarding", "Ramp Team"], assignment: "Air France", shift_code: "AP01", rest_before_shift_hours: 12, weekly_hours: 24, foreign_company_authorizations: ["Air France"], offDayRotation: ["Tuesday", "Saturday"] },
  // Authorized for a foreign company but currently placed in the General
  // T1 Pool — proves authorization doesn't imply placement, at a
  // slightly larger scale than the original single example.
  { count: 4, skills: ["Boarding", "Ramp Team"], assignment: "General T1 Pool", shift_code: "NR01", rest_before_shift_hours: 11, weekly_hours: 22, foreign_company_authorizations: ["Air France", "Qatar Airways"], offDayRotation: ["Sunday", "Wednesday"] },
];

export function generateEmployees(startIndex = 0): Omit<Employee, "weekly_shifts">[] {
  const employees: Omit<Employee, "weekly_shifts">[] = [];
  let i = startIndex;

  for (const spec of [...CATEGORIES, ...FOREIGN_GROUPS]) {
    for (let n = 0; n < spec.count; n++) {
      const name = nameForIndex(i);
      const { shift_start, shift_end } = getShiftTimesAs(spec.shift_code);
      const off_days = spec.offDayRotation ? [spec.offDayRotation[n % spec.offDayRotation.length]] : spec.off_days ?? [];
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
