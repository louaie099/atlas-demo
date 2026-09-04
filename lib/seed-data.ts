import { Employee, Flight, Config, WeeklyShiftEntry } from "./types";
import { generateEmployees } from "./employee-generator";
import { generateWeeklyFlights } from "./flight-generator";
import { getShiftTimesAs, buildUniformWeeklySchedule } from "./shift-templates";
import { CONFIGURED_COMPANIES } from "./company-config";
import { planForeignCompanyDay } from "./foreign-shift-planning";
import { buildStaggeredOffDays, offDaysCountForShift, restHoursBetween } from "./roster-generation";

export const CONFIG: Config = {
  minimum_rest_hours: 10,
  fairness_ceiling_hours: 40,
  baseline_checkin_requirement: 4,
  overbooking_checkin_reinforcement: 2,
};

// Only this week currently has scheduled flights seeded. Week navigation in
// the UI is built to support other weeks, but no other week's data exists
// yet — an honest empty state, not fabricated flights.
export const CURRENT_WEEK_LABEL = "Week of Mon, Sep 1 2026";
export const DAYS_WITH_DATA = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// The only day with real flight data (AT201/AT535 and the generated
// week's Wednesday instances). Workforce-view "today" concepts anchor to
// this rather than the real wall-clock date, since the demo's populated
// week is fixed, not live.
export const DEMO_TODAY = "Wednesday";

// The 8 scripted employees below are protected — rest_before_shift_hours
// and weekly_hours must not change, since 02-scenario-script.md and the
// test suite depend on exact values (Nadia's 11h rest, Karim's 38h weekly
// hours, etc.). Shift times are sourced from the authoritative shift
// catalog (lib/shift-templates.ts) wherever a real code produces the same
// tested behavior. Karim is the one deliberate exception — see his comment.
// Nadia's roles previously included "Transit" — removed here, since Transit
// is an assignment (where she'd be placed), not a skill (what she can do);
// this was exactly the confusion the skill/assignment split corrects.
// weekly_shifts is added centrally below, not per-employee here.
//
// off_days: previously [] for all 8 (a 7-day work week for every one of
// them) — that was never a deliberate scenario requirement, just an
// unfixed default, and it meant these employees' weekly hours (via real
// shift durations) were guaranteed to exceed the fairness ceiling. Now
// derived the same way the generated workforce's off days are (see
// roster-generation.ts), staggered per employee so the 7 scripted
// employees don't all share the same OFF day. Wednesday — the one day the
// scripted AT201/AT535 scenario and live scoring run against — is
// deliberately excluded from the candidate pool for all of them, so
// nothing about the scripted narrative changes.
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
    // Deliberate exception: no authoritative code ends before 14:20
    // (AT201's boarding window end) — every morning code (MT01/MT02) runs
    // until 14:45. Forcing Karim onto one would silently remove the
    // "unplanned shift extension" reasoning the scripted scenario and
    // tests depend on. Kept as a custom, non-catalog shift instead of
    // forcing a mismatched real code. Because shift_code is null,
    // computeScheduledWeeklyHours (lib/planning/validation.ts) doesn't
    // count any of his days toward the weekly-hours ceiling at all — his
    // off_days below are for roster realism only, not a ceiling
    // computation; a small fixed weekend pattern is used rather than the
    // shift-duration-driven formula, since there's no real shift duration
    // to derive it from.
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
    // JR01 — matches "Leaders/Duty Officers use fixed JR/NT-type planning."
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

// Concrete proof that daily roster entries genuinely vary day-to-day, not
// just structurally. Skill is deliberately one no current
// StaffingRequirement queries (Gate) — this avoids this employee appearing
// in a live Find Agent list for AT201/AT535 while scoring.ts is still
// day-unaware (that's future Weekly Planning engine work, not this step).
// Wednesday is intentionally kept as a normal working day, matching what
// the flat shift_start/shift_end fields say, so nothing about today's
// single-day behavior is affected.
//
// Previously included a Sunday JR01 shift, which — combined with 3x MT01
// and 2x AP01 — totaled 57.5h/week, itself a weekly-hours-ceiling
// violation this same iteration is meant to fix elsewhere. Dropped to 4
// working days (3x MT01 + 1x AP01 = 36h) while keeping the day-to-day
// shift-code variation the comment above is about.
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
    shift_code: "MT01", // matches Wednesday's entry in the pattern below
    ...getShiftTimesAs("MT01"),
    rest_before_shift_hours: 11,
    weekly_hours: 24,
    is_duty_officer: false,
    off_days: ["Thursday"],
    foreign_company_authorizations: [],
    active: true,
  },
];

// AT201 and AT535 are protected — hand-authored, exact values depended on
// by 02-scenario-script.md and the test suite. Never touched by generation.
export const SCRIPTED_FLIGHTS: Flight[] = [
  {
    id: "at201",
    flight_number: "AT201",
    airline: "Royal Air Maroc",
    route: "CMN → CDG",
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
    route: "CMN → ORY",
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

// The full week's remaining flights (all days), generated from coherent
// recurring templates. Built BEFORE EMPLOYEES below, since foreign-company
// employees' weekly shifts are now derived FROM the flight schedule, not
// the other way around.
export const FLIGHTS: Flight[] = [...SCRIPTED_FLIGHTS, ...generateWeeklyFlights()];

/**
 * For an employee currently assigned to a foreign company, the company's
 * flight schedule drives their shift on each day — not a fixed weekly
 * pattern with a flight bolted on afterward. For each day: if that
 * company has a flight, select the RAM shift that covers the required
 * protected window (see foreign-shift-planning.ts) and use it for that
 * day; if the company has no flight that day, keep the employee's normal
 * fallback shift untouched — no fake commitment is invented.
 *
 * OFF days are genuinely left untouched here — but that's now a
 * consequence, not a bug: employee-generator.ts (and the scripted-
 * employee off_days above) already choose OFF days preferring days the
 * employee's own company does NOT fly, precisely so this function rarely
 * has to face "OFF on a day the company actually needed them." The one
 * place that preference can't hold is a company that flies every single
 * day (Emirates) — there, some OFF days will genuinely coincide with a
 * company flight day for some group members; that's an honest structural
 * constraint (not everyone can be off only on days the company doesn't
 * fly, when it flies daily), reported as-is rather than silently patched
 * over by overriding someone's OFF day here.
 */
/**
 * Cross-day rest-aware, processed sequentially (Monday -> Sunday) per
 * employee — the same causal order as Stage 6's shift generation:
 * operational commitment (does the company fly today?) -> compatible
 * shift -> rest validation against the employee's own actual shift
 * yesterday -> selected shift. `prevShiftEnd` carries that actual
 * previous-day end time forward one day at a time; a real company
 * flight's protected window is never abandoned FOR fit reasons, only
 * because no catalog shift can satisfy both the window and the hard rest
 * rule — in which case this exposes it as the employee not working that
 * day, a real visible reduction in that day's foreign-team capacity,
 * rather than silently generating an under-rested roster.
 */
function applyForeignCompanyRoster(employee: Employee): Employee {
  if (!CONFIGURED_COMPANIES.includes(employee.assignment)) return employee;

  const weekly_shifts: WeeklyShiftEntry[] = [];
  let prevShiftEnd: string | null = null;

  for (const entry of employee.weekly_shifts) {
    if (entry.status === "off") {
      weekly_shifts.push(entry);
      prevShiftEnd = null;
      continue;
    }

    const plan = planForeignCompanyDay(
      employee.assignment,
      entry.day_of_week,
      FLIGHTS,
      prevShiftEnd,
      CONFIG.minimum_rest_hours
    );

    if (plan) {
      if (plan.shiftCode) {
        weekly_shifts.push({ ...entry, shift_code: plan.shiftCode, status: "working" });
        prevShiftEnd = getShiftTimesAs(plan.shiftCode).shift_end;
      } else {
        // A real company flight exists today, but no catalog shift both
        // covers the protected window and leaves this employee rested
        // since yesterday's actual shift. Never force an illegal roster
        // to hit the commitment — this is a genuine coverage problem
        // (this employee doesn't work today), not an invented one.
        weekly_shifts.push({ ...entry, shift_code: null, status: "off" });
        prevShiftEnd = null;
      }
      continue;
    }

    // No company flight today — the employee's existing (baseline) shift
    // applies, but it's still subject to the same rest rule: a normal,
    // unprotected working day is never worth generating an illegal
    // roster over either.
    if (
      entry.shift_code &&
      prevShiftEnd != null &&
      restHoursBetween(prevShiftEnd, getShiftTimesAs(entry.shift_code).shift_start) < CONFIG.minimum_rest_hours
    ) {
      weekly_shifts.push({ ...entry, shift_code: null, status: "off" });
      prevShiftEnd = null;
      continue;
    }

    weekly_shifts.push(entry);
    prevShiftEnd = entry.shift_code ? getShiftTimesAs(entry.shift_code).shift_end : null;
  }

  return { ...employee, weekly_shifts };
}

// Full workforce: the 8 protected scripted employees, the generated pool
// (197 more, distributed across General T1 Pool, specialized/fixed teams,
// and foreign-company groups — see employee-generator.ts), and the
// rotating-shift example, reaching 206 total. ~200 is the intended scale
// for this stage — not expanded further. Foreign-company assigned
// employees' weekly_shifts are then adjusted to match their company's
// actual flight schedule.
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

// Baseline Check-in staffing already covering AT535's 4-person baseline,
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
