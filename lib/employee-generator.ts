import { Employee } from "./types";
import { getShiftTimesAs } from "./shift-templates";
import { buildStaggeredOffDays } from "./roster-generation";
import { companyOperatingDays } from "./flight-generator";
import { getCompanyRequiredAgents } from "./company-config";
import { resolveDefaultLaborRules } from "./labor-rules";
import { deriveTeamRotation, DemandDay, RotationInfeasibleError } from "./rotation-feasibility";

const ALL_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/**
 * OFF-day count no longer comes from a weekly-hours ceiling (there is no
 * confirmed ceiling — see lib/labor-rules.ts). The confirmed rule is a
 * flat 2 OFF days/week for everyone in a normal week; a foreign-company
 * team's actual OFF-day PLACEMENT (which 2 days, and how the team splits
 * into rotating subgroups) is instead derived per-company below by the
 * generic Rotation Feasibility Engine (lib/rotation-feasibility.ts) from
 * that company's real flight demand — never hand-picked, never
 * duration-based.
 */
const LABOR_RULES = resolveDefaultLaborRules();

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
  // Categories whose skills are queried by a live requirement today
  // (Boarding, Check-in) keep Wednesday as a working day for every
  // member — scoring.ts doesn't yet check per-day off-status, so marking
  // someone off on the one day live scoring runs against would create a
  // new, avoidable inconsistency rather than fix one. OFF-day COUNT and
  // distribution are otherwise derived from the shift's real duration
  // (see roster-generation.ts), never hand-picked per category.
  keepWednesdayWorking?: boolean;
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
  { count: 20, skills: ["Check-in", "Weight Control"], assignment: "General T1 Pool", shift_code: "NR01", rest_before_shift_hours: 12, weekly_hours: 16, keepWednesdayWorking: true },
  { count: 20, skills: ["Check-in", "Weight Control"], assignment: "General T1 Pool", shift_code: "MT01", rest_before_shift_hours: 12, weekly_hours: 18, keepWednesdayWorking: true },
  // Intermediate ACEs — Boarding + Gate. Holds Boarding — no Wednesday.
  { count: 20, skills: ["Boarding", "Gate"], assignment: "General T1 Pool", shift_code: "AP01", rest_before_shift_hours: 11, weekly_hours: 24, keepWednesdayWorking: true },
  // Intermediate ACEs — Gate + Care Point + Check-in.
  { count: 16, skills: ["Gate", "Care Point", "Check-in"], assignment: "General T1 Pool", shift_code: "AP02", rest_before_shift_hours: 11, weekly_hours: 22, keepWednesdayWorking: true },
  // Experienced, multi-skilled ACEs — weekly hours intentionally near the
  // fairness ceiling, demonstrating a genuine fairness constraint beyond
  // Karim. Holds Boarding/Check-in — no Wednesday.
  { count: 10, skills: ["Boarding", "Gate", "Care Point", "Check-in"], assignment: "General T1 Pool", shift_code: "NR02", rest_before_shift_hours: 10, weekly_hours: 36, keepWednesdayWorking: true },
  { count: 10, skills: ["Boarding", "Gate", "Care Point", "Check-in"], assignment: "General T1 Pool", shift_code: "JR01", rest_before_shift_hours: 10, weekly_hours: 34, keepWednesdayWorking: true },

  // ---- Specialized/fixed teams ----
  // Transit — committed for the full shift once on it. Skill is the
  // confirmed "Transit" qualification, not the removed "Arrivals". Split
  // into two shift patterns; safe to be off on Wednesday since Transit
  // isn't queried by any live Find-Agent role.
  { count: 8, skills: ["Transit"], assignment: "Transit", shift_code: "MT01", rest_before_shift_hours: 11, weekly_hours: 28 },
  { count: 6, skills: ["Transit"], assignment: "Transit", shift_code: "AP01", rest_before_shift_hours: 11, weekly_hours: 26 },
  // Profiling — document verification. Real Profiling skill, some also Boarding.
  { count: 7, skills: ["Profiling"], assignment: "Profiling", shift_code: "NR02", rest_before_shift_hours: 11, weekly_hours: 22, keepWednesdayWorking: true },
  { count: 5, skills: ["Profiling", "Boarding"], assignment: "Profiling", shift_code: "AP02", rest_before_shift_hours: 11, weekly_hours: 24, keepWednesdayWorking: true },
  // Mesure — carry-on inspection at the gate. Real Mesure skill; a subset
  // also Profiling-qualified, per the explicit instruction. Rest hours
  // intentionally tight for one sub-group, demonstrating a rest
  // constraint within a specialized assignment, not only General T1.
  { count: 8, skills: ["Mesure"], assignment: "Mesure", shift_code: "MT02", rest_before_shift_hours: 9, weekly_hours: 30 },
  { count: 4, skills: ["Mesure", "Profiling"], assignment: "Mesure", shift_code: "NR01", rest_before_shift_hours: 11, weekly_hours: 24, keepWednesdayWorking: true },
  // Caisse/BCB — the payment desk. Fixed planning, excluded from general
  // allocation regardless of off-status. Real rotation TBD — placeholder
  // OFF-day distribution only.
  { count: 6, skills: ["Caisse/BCB"], assignment: "Caisse/BCB", shift_code: "NR01", rest_before_shift_hours: 12, weekly_hours: 20 },
  // Baggage Claim — no confirmed dedicated skill exists yet (see module
  // comment); "Weight Control" used as the closest defensible baseline.
  { count: 6, skills: ["Weight Control"], assignment: "Baggage Claim", shift_code: "NR01", rest_before_shift_hours: 11, weekly_hours: 20 },
  // Service Plus — T1-based premium/VIP/business-class/lounge activity.
  { count: 6, skills: ["Service Plus"], assignment: "Service Plus", shift_code: "AP02", rest_before_shift_hours: 12, weekly_hours: 18, keepWednesdayWorking: true },
  // Leaders — confirmed fixed JR-type planning, excluded from general
  // allocation regardless of off-status. Real rotation TBD — placeholder
  // OFF-day distribution only.
  { count: 5, skills: ["Boarding"], assignment: "Leaders", shift_code: "JR02", rest_before_shift_hours: 12, weekly_hours: 32 },
  // Duty Officers — confirmed fixed NT/JR-type planning (night/day
  // coverage). Kept working Wednesday so the narrative (Mohammed Alaoui
  // approving on Wednesday) doesn't read oddly next to others being off
  // the same day.
  { count: 4, skills: ["Boarding"], assignment: "Duty Officers", shift_code: "NT01", rest_before_shift_hours: 12, weekly_hours: 30, keepWednesdayWorking: true },
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
  { count: 9, skills: ["Boarding", "Ramp Team"], assignment: "Emirates", shift_code: "NR01", rest_before_shift_hours: 11, weekly_hours: 26, foreign_company_authorizations: ["Emirates", "Etihad"], keepWednesdayWorking: true },
  { count: 7, skills: ["Boarding", "Ramp Team"], assignment: "Qatar Airways", shift_code: "NR01", rest_before_shift_hours: 12, weekly_hours: 24, foreign_company_authorizations: ["Qatar Airways", "Gulf Air"], keepWednesdayWorking: true },
  { count: 6, skills: ["Boarding", "Ramp Team"], assignment: "Gulf Air", shift_code: "MT02", rest_before_shift_hours: 11, weekly_hours: 25, foreign_company_authorizations: ["Gulf Air"], keepWednesdayWorking: true },
  { count: 5, skills: ["Boarding", "Ramp Team"], assignment: "Etihad", shift_code: "NR02", rest_before_shift_hours: 12, weekly_hours: 23, foreign_company_authorizations: ["Etihad", "Emirates"], keepWednesdayWorking: true },
  { count: 5, skills: ["Boarding", "Ramp Team"], assignment: "Air France", shift_code: "AP01", rest_before_shift_hours: 12, weekly_hours: 24, foreign_company_authorizations: ["Air France"], keepWednesdayWorking: true },
  // Authorized for a foreign company but currently placed in the General
  // T1 Pool — proves authorization doesn't imply placement, at a
  // slightly larger scale than the original single example.
  { count: 4, skills: ["Boarding", "Ramp Team"], assignment: "General T1 Pool", shift_code: "NR01", rest_before_shift_hours: 11, weekly_hours: 22, foreign_company_authorizations: ["Air France", "Qatar Airways"] },
];

/**
 * For a foreign-company-assigned group, OFF days should preferentially
 * fall on days that company has no flight at all — the "protected
 * commitments and working-hour limits together" rule the roster
 * generator is meant to respect. For any other assignment,
 * companyOperatingDays returns [] (no flight template matches a non-
 * airline assignment name), so this is simply undefined — no preference,
 * full candidate pool. When a company flies every day (Emirates), there
 * is no non-flight day to prefer; OFF-day selection then falls back to
 * the full pool, an honest, unavoidable constraint, not a hidden gap.
 */
function preferredOffDaysFor(assignment: string): string[] | undefined {
  const flightDays = companyOperatingDays(assignment);
  if (flightDays.length === 0) return undefined;
  const nonFlightDays = ALL_DAYS.filter((d) => !flightDays.includes(d));
  return nonFlightDays.length > 0 ? nonFlightDays : undefined;
}

/**
 * Builds the real weekly demand for a configured foreign company from its
 * ACTUAL flight days (lib/flight-generator.ts) and its ACTUAL configured
 * per-flight agent requirement (lib/company-config.ts) — never a guessed
 * or company-name-branched number. Returns undefined for any assignment
 * that isn't a configured company with at least one seeded flight, so the
 * caller falls back to the flat, non-rotation path for those groups
 * (e.g. an authorized-but-unassigned pool, or an unconfigured carrier).
 */
function realWeeklyDemandFor(assignment: string): DemandDay[] | undefined {
  const flightDays = companyOperatingDays(assignment);
  const requiredAgents = getCompanyRequiredAgents(assignment);
  if (flightDays.length === 0 || requiredAgents === undefined) return undefined;
  return ALL_DAYS.map((d) => ({ dayOfWeek: d, requiredAgents: flightDays.includes(d) ? requiredAgents : 0 }));
}

/**
 * Assigns off_days for one foreign-company GROUP by running the generic
 * Rotation Feasibility Engine against that company's real weekly demand.
 * Never branches on the company's name — only on its headcount and its
 * actual flights, exactly like every other input to deriveTeamRotation.
 *
 * If deriveTeamRotation reports infeasible, that is a genuine capacity
 * gap — this function throws RotationInfeasibleError rather than
 * inventing an unrelated flat roster to paper over it. Generation must
 * not proceed with a fabricated schedule for a team the feasibility
 * engine has rejected; the fix is a real human action (add headcount, or
 * an explicit renfort decision once that workflow exists), not a
 * quieter fallback here.
 */
function offDaysForForeignGroup(spec: GenSpec): string[][] {
  const demand = realWeeklyDemandFor(spec.assignment);
  if (!demand) {
    // Not a configured company with real seeded flights (e.g. an
    // authorized-but-unassigned pool) — there is no operational demand to
    // test a rotation against, so the confirmed flat rule applies
    // directly, same as the internal RAM teams.
    const preferredOffDays = preferredOffDaysFor(spec.assignment);
    const candidatePool = spec.keepWednesdayWorking ? ALL_DAYS.filter((d) => d !== "Wednesday") : ALL_DAYS;
    return Array.from({ length: spec.count }, (_, n) =>
      buildStaggeredOffDays(n, LABOR_RULES.normalWeeklyOffDays, candidatePool, preferredOffDays)
    );
  }

  const result = deriveTeamRotation(spec.count, demand, ALL_DAYS, LABOR_RULES.normalWeeklyOffDays);
  if (!result.feasible || !result.candidate) {
    throw new RotationInfeasibleError(spec.assignment, spec.count, demand, result.reason ?? "No feasible rotation found.");
  }

  const perEmployee: string[][] = [];
  for (const group of result.candidate.groups) {
    for (let k = 0; k < group.size; k++) perEmployee.push(group.offDays);
  }
  return perEmployee;
}

export function generateEmployees(startIndex = 0): Omit<Employee, "weekly_shifts">[] {
  const employees: Omit<Employee, "weekly_shifts">[] = [];
  let i = startIndex;

  for (const spec of CATEGORIES) {
    // Internal RAM teams have no operational-demand/rotation question to
    // answer (they aren't tied to a specific foreign company's flight
    // schedule) — the confirmed flat rule applies directly: 2 OFF
    // days/week, staggered so the team isn't all off the same days.
    const candidatePool = spec.keepWednesdayWorking ? ALL_DAYS.filter((d) => d !== "Wednesday") : ALL_DAYS;

    for (let n = 0; n < spec.count; n++) {
      const name = nameForIndex(i);
      const { shift_start, shift_end } = getShiftTimesAs(spec.shift_code);
      const off_days = buildStaggeredOffDays(n, LABOR_RULES.normalWeeklyOffDays, candidatePool);
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

  for (const spec of FOREIGN_GROUPS) {
    const offDaysByMember = offDaysForForeignGroup(spec);

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
        off_days: offDaysByMember[n],
        foreign_company_authorizations: spec.foreign_company_authorizations ?? [],
        active: true,
      });
      i++;
    }
  }

  return employees;
}
