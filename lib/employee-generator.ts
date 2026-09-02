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
  skills: string[];
  assignment: string; // internal RAM service (see teams.ts) OR a foreign company name (see company-config.ts)
  shift_code: string; // authoritative code from shift-templates.ts
  rest_before_shift_hours: number;
  weekly_hours: number;
  foreign_company_authorizations?: string[];
  off_days?: string[];
  // Rotates a pool of days across the members of this category (person 0
  // gets offDayRotation[0], person 1 gets offDayRotation[1 % length],
  // etc.) so a whole team isn't off on the same day at once. Categories
  // whose skills are queried by a live requirement today (Boarding,
  // Check-in) deliberately exclude "Wednesday" from their rotation —
  // scoring.ts doesn't yet check per-day off-status (a known, flagged
  // gap), so marking someone off on the one day live scoring runs against
  // would create a new, avoidable inconsistency rather than fix one.
  offDayRotation?: string[];
}

/**
 * Category definitions matching the requested distribution. Shift codes
 * are drawn from the authoritative catalog (lib/shift-templates.ts) —
 * chosen per category for plausibility (e.g. Leaders/Duty Officers get
 * JR/NT codes, per the confirmed "fixed JR/NT-type planning" rule), not
 * invented times. Rest/weekly-hours values are deliberately varied to
 * demonstrate fairness/rest constraints across categories, not just the
 * original scripted employees.
 *
 * Skill vs assignment: `skills` is what the employee can DO (Boarding,
 * Gate, Check-in, Arrivals, plus a few pre-existing qualifiers — Weight
 * Control, Care Point, Ramp Team — that predate the confirmed skill
 * catalog and are kept as-is). `assignment` is where they're CURRENTLY
 * placed. The two are independent: a Boarding-skilled employee's
 * assignment can be Profiling, and a foreign-company assignment doesn't
 * require any particular skill beyond what that company's role needs.
 */
const CATEGORIES: GenSpec[] = [
  // Newer T1 ACEs — basic skills only. Holds Check-in (queried live) —
  // rotation excludes Wednesday.
  { count: 6, skills: ["Check-in", "Weight Control"], assignment: "General T1 Pool", shift_code: "NR01", rest_before_shift_hours: 12, weekly_hours: 16, offDayRotation: ["Monday", "Tuesday", "Thursday", "Friday", "Saturday", "Sunday"] },
  // Intermediate ACEs — Boarding + Gate. Holds Boarding — no Wednesday.
  { count: 5, skills: ["Boarding", "Gate"], assignment: "General T1 Pool", shift_code: "AP01", rest_before_shift_hours: 11, weekly_hours: 24, offDayRotation: ["Monday", "Tuesday", "Thursday", "Friday", "Saturday"] },
  // Experienced, multi-skilled ACEs — weekly hours intentionally near the
  // fairness ceiling, demonstrating a genuine fairness constraint beyond
  // Karim. Holds Boarding/Check-in — no Wednesday.
  { count: 4, skills: ["Boarding", "Gate", "Care Point", "Check-in"], assignment: "General T1 Pool", shift_code: "NR02", rest_before_shift_hours: 10, weekly_hours: 36, offDayRotation: ["Monday", "Tuesday", "Thursday", "Friday"] },
  // Dedicated Transit agents — strictly unavailable outside Transit for
  // the full shift. Skill (Arrivals) isn't queried live — safe to include
  // Wednesday, staggered so the whole team is never off together.
  { count: 4, skills: ["Arrivals"], assignment: "Transit", shift_code: "MT01", rest_before_shift_hours: 11, weekly_hours: 28, offDayRotation: ["Monday", "Wednesday", "Friday", "Sunday"] },
  // Profiling — document verification. Holds Boarding — no Wednesday.
  { count: 3, skills: ["Boarding"], assignment: "Profiling", shift_code: "NR02", rest_before_shift_hours: 11, weekly_hours: 22, offDayRotation: ["Monday", "Thursday", "Saturday"] },
  // Mesure — carry-on inspection at the gate. Rest hours intentionally
  // below the minimum for this category, demonstrating a rest constraint
  // within a specialized assignment, not only the General T1 pool. Skill
  // (Gate) isn't queried live — safe to include Wednesday.
  { count: 3, skills: ["Gate"], assignment: "Mesure", shift_code: "MT02", rest_before_shift_hours: 9, weekly_hours: 30, offDayRotation: ["Wednesday", "Friday", "Sunday"] },
  // Baggage Claim — baggage claim area, including baggage-loss handling.
  // Skill (Arrivals) isn't queried live — safe to include Wednesday.
  { count: 2, skills: ["Arrivals"], assignment: "Baggage Claim", shift_code: "NR01", rest_before_shift_hours: 11, weekly_hours: 20, offDayRotation: ["Wednesday", "Saturday"] },
  // Caisse/BCB — the payment desk. Fixed planning, excluded from general
  // allocation regardless of off-status — Wednesday is safe either way.
  { count: 2, skills: ["Check-in"], assignment: "Caisse/BCB", shift_code: "NR01", rest_before_shift_hours: 12, weekly_hours: 20, offDayRotation: ["Wednesday", "Monday"] },
  // Service Plus — T1-based premium/VIP/business-class/lounge activity. No
  // further operational rules were provided. Holds Boarding — no Wednesday.
  { count: 2, skills: ["Boarding"], assignment: "Service Plus", shift_code: "AP02", rest_before_shift_hours: 12, weekly_hours: 18, offDayRotation: ["Tuesday", "Friday"] },
  // Leaders — confirmed fixed JR-type planning, excluded from general
  // allocation regardless of off-status — Wednesday is safe either way.
  { count: 2, skills: ["Boarding"], assignment: "Leaders", shift_code: "JR02", rest_before_shift_hours: 12, weekly_hours: 32, offDayRotation: ["Wednesday", "Thursday"] },
  // One additional Duty Officer alongside the existing scripted one —
  // confirmed fixed NT-type planning (night coverage). Excluded from
  // general allocation regardless; kept off Wednesday only so the
  // narrative (Mohammed Alaoui approving on Wednesday) doesn't read
  // oddly next to a second Duty Officer being off the same day.
  { count: 1, skills: ["Boarding"], assignment: "Duty Officers", shift_code: "NT01", rest_before_shift_hours: 12, weekly_hours: 30, off_days: ["Saturday"] },
];

/**
 * Foreign-company examples, authored individually rather than as one
 * uniform category, specifically to demonstrate skill vs assignment vs
 * authorization as three genuinely different things:
 *  - the first two are CURRENTLY ASSIGNED to a foreign company this week
 *    (assignment = the company name itself) — real foreign assignments,
 *    not just latent authorization.
 *  - the third is AUTHORIZED for two companies but currently assigned to
 *    General T1 Pool — proving authorization doesn't imply placement.
 * Off days kept off Wednesday: these hold Boarding (queried live), and
 * Wednesday is also their real foreign-commitment day for the first two
 * (see reset-database.ts) — no reason to touch it here.
 */
const FOREIGN_EXAMPLES: GenSpec[] = [
  { count: 1, skills: ["Boarding", "Ramp Team"], assignment: "Emirates", shift_code: "NR01", rest_before_shift_hours: 11, weekly_hours: 26, foreign_company_authorizations: ["Emirates", "Etihad"], off_days: ["Tuesday"] },
  { count: 1, skills: ["Boarding", "Ramp Team"], assignment: "Qatar Airways", shift_code: "NR01", rest_before_shift_hours: 12, weekly_hours: 24, foreign_company_authorizations: ["Qatar Airways", "Gulf Air"], off_days: ["Saturday"] },
  { count: 1, skills: ["Boarding", "Ramp Team"], assignment: "General T1 Pool", shift_code: "NR01", rest_before_shift_hours: 11, weekly_hours: 22, foreign_company_authorizations: ["Air France", "Qatar Airways"], off_days: ["Sunday"] },
];

export function generateEmployees(startIndex = 0): Omit<Employee, "weekly_shifts">[] {
  const employees: Omit<Employee, "weekly_shifts">[] = [];
  let i = startIndex;

  for (const spec of [...CATEGORIES, ...FOREIGN_EXAMPLES]) {
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
