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
  // Newer T1 ACEs — basic skills only.
  { count: 6, skills: ["Check-in", "Weight Control"], assignment: "General T1 Pool", shift_code: "NR01", rest_before_shift_hours: 12, weekly_hours: 16 },
  // Intermediate ACEs — Boarding + Gate.
  { count: 5, skills: ["Boarding", "Gate"], assignment: "General T1 Pool", shift_code: "AP01", rest_before_shift_hours: 11, weekly_hours: 24 },
  // Experienced, multi-skilled ACEs — weekly hours intentionally near the
  // fairness ceiling, demonstrating a genuine fairness constraint beyond Karim.
  { count: 4, skills: ["Boarding", "Gate", "Care Point", "Check-in"], assignment: "General T1 Pool", shift_code: "NR02", rest_before_shift_hours: 10, weekly_hours: 36 },
  // Dedicated Transit agents — strictly unavailable outside Transit for the full shift.
  { count: 4, skills: ["Arrivals"], assignment: "Transit", shift_code: "MT01", rest_before_shift_hours: 11, weekly_hours: 28 },
  // Profiling — document verification for transitioning passengers.
  { count: 3, skills: ["Boarding"], assignment: "Profiling", shift_code: "NR02", rest_before_shift_hours: 11, weekly_hours: 22 },
  // Mesure — carry-on inspection at the gate. Rest hours intentionally
  // below minimum, demonstrating a rest constraint within a specialized
  // assignment, not only the General T1 pool.
  { count: 3, skills: ["Gate"], assignment: "Mesure", shift_code: "MT02", rest_before_shift_hours: 9, weekly_hours: 30 },
  // Baggage Claim — baggage claim area, including baggage-loss handling.
  { count: 2, skills: ["Arrivals"], assignment: "Baggage Claim", shift_code: "NR01", rest_before_shift_hours: 11, weekly_hours: 20 },
  // Caisse/BCB — the payment desk. Fixed planning, excluded from general allocation.
  { count: 2, skills: ["Check-in"], assignment: "Caisse/BCB", shift_code: "NR01", rest_before_shift_hours: 12, weekly_hours: 20 },
  // Service Plus — T1-based premium/VIP/business-class/lounge activity. No
  // further operational rules were provided, so this is skill/assignment only.
  { count: 2, skills: ["Boarding"], assignment: "Service Plus", shift_code: "AP02", rest_before_shift_hours: 12, weekly_hours: 18 },
  // Leaders — confirmed fixed JR-type planning.
  { count: 2, skills: ["Boarding"], assignment: "Leaders", shift_code: "JR02", rest_before_shift_hours: 12, weekly_hours: 32 },
  // One additional Duty Officer alongside the existing scripted one —
  // confirmed fixed NT-type planning (night coverage).
  { count: 1, skills: ["Boarding"], assignment: "Duty Officers", shift_code: "NT01", rest_before_shift_hours: 12, weekly_hours: 30 },
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
 */
const FOREIGN_EXAMPLES: GenSpec[] = [
  { count: 1, skills: ["Boarding", "Ramp Team"], assignment: "Emirates", shift_code: "NR01", rest_before_shift_hours: 11, weekly_hours: 26, foreign_company_authorizations: ["Emirates", "Etihad"] },
  { count: 1, skills: ["Boarding", "Ramp Team"], assignment: "Qatar Airways", shift_code: "NR01", rest_before_shift_hours: 12, weekly_hours: 24, foreign_company_authorizations: ["Qatar Airways", "Gulf Air"] },
  { count: 1, skills: ["Boarding", "Ramp Team"], assignment: "General T1 Pool", shift_code: "NR01", rest_before_shift_hours: 11, weekly_hours: 22, foreign_company_authorizations: ["Air France", "Qatar Airways"] },
];

export function generateEmployees(startIndex = 0): Omit<Employee, "weekly_shifts">[] {
  const employees: Omit<Employee, "weekly_shifts">[] = [];
  let i = startIndex;

  for (const spec of [...CATEGORIES, ...FOREIGN_EXAMPLES]) {
    for (let n = 0; n < spec.count; n++) {
      const name = nameForIndex(i);
      const { shift_start, shift_end } = getShiftTimesAs(spec.shift_code);
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
        off_days: spec.off_days ?? [],
        foreign_company_authorizations: spec.foreign_company_authorizations ?? [],
      });
      i++;
    }
  }

  return employees;
}
