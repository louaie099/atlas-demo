import { Employee, Flight, Config, WeeklyShiftEntry } from "./types";
import { generateEmployees, generateFixedCycleEmployees } from "./employee-generator";
import { generateWeeklyFlights } from "./flight-generator";
import { getShiftTimesAs, buildUniformWeeklySchedule, restHoursForDailyRepeatingShift } from "./shift-templates";
import { CONFIGURED_COMPANIES } from "./company-config";
import { planForeignCompanyDay } from "./foreign-shift-planning";
import { buildStaggeredOffDays } from "./roster-generation";
import { resolveDefaultLaborRules } from "./labor-rules";
import { buildFixedCycleWeeklySchedule, JR_NT_OFF_OFF_CYCLE } from "./fixed-cycle-rotation";
import { usesFixedCycleRotation } from "./teams";
import { DEFAULT_CHECKIN_DEMAND_POLICY } from "./planning/checkin-demand";

// minimum_rest_hours and maximum_average_weekly_working_hours are sourced
// from lib/labor-rules.ts, not hand-picked here — 15h rest is confirmed
// and continuously enforced; 42h is a confirmed AVERAGE, not a
// Monday-Sunday ceiling, and working_hours_reference_period_days is not
// yet confirmed (null) — see that file's module comment. Never duplicate
// these numbers elsewhere — every generator/validator reads them from
// this CONFIG object (itself read from the resolver).
const DEFAULT_RULES = resolveDefaultLaborRules();

export const CONFIG: Config = {
  minimum_rest_hours: DEFAULT_RULES.minimumRestHours,
  maximum_average_weekly_working_hours: DEFAULT_RULES.maximumAverageWeeklyWorkingHours,
  working_hours_reference_period_days: DEFAULT_RULES.workingHoursReferencePeriodDays,
  baseline_checkin_requirement: 4,
  overbooking_checkin_reinforcement: 2,
  checkin_demand_policy: DEFAULT_CHECKIN_DEMAND_POLICY,
  normal_weekly_off_days: DEFAULT_RULES.normalWeeklyOffDays,
  max_consecutive_off_days: DEFAULT_RULES.maxConsecutiveOffDays,
  renfort_weekly_off_days: DEFAULT_RULES.renfortWeeklyOffDays,
};

// Only this week currently has scheduled flights seeded. Week navigation in
// the UI is built to support other weeks, but no other week's data exists
// yet — an honest empty state, not fabricated flights.
export const CURRENT_WEEK_LABEL = "Week of Mon, Sep 1 2026";
// Identifier for the currently-seeded demo week -- used as the WeeklyPlan's
// week_start/id key (see lib/planning/weekly-plan-service.ts), NOT
// validated against a real calendar (matches CURRENT_WEEK_LABEL's own
// existing convention of being a fixed demo label, not a derived date).
export const CURRENT_WEEK_START = "2026-09-01";
export const DAYS_WITH_DATA = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// The only day with real flight data (AT201/AT535 and the generated
// week's Wednesday instances). Workforce-view "today" concepts anchor to
// this rather than the real wall-clock date, since the demo's populated
// week is fixed, not live.
export const DEMO_TODAY = "Wednesday";

// The 8 scripted employees below are protected — weekly_hours (Karim's
// 38h, etc.) must not change, since 02-scenario-script.md and the test
// suite depend on those exact values. rest_before_shift_hours is the ONE
// exception: it is now always DERIVED from each employee's real shift
// code via restHoursForDailyRepeatingShift (lib/shift-templates.ts),
// never an independently hand-picked number — the previous flat 10-13h
// values predated the confirmed 15h rest floor and were never
// reconciled against it. Some of these scripted employees' derived rest
// now falls below the confirmed 15h floor (Nadia's NR02: 13.75h; Youssef
// and Rania's AP02/MT02: 14.5h/13.75h) — this is the honest, reportable
// consequence of the confirmed rule, not something to paper over by
// picking a different shift code just to preserve the old narrative
// outcome; see the delivered report. Shift times are sourced from the
// authoritative shift catalog (lib/shift-templates.ts) wherever a real
// code produces the same tested behavior. Karim is the one deliberate
// exception — see his comment.
// Nadia's roles previously included "Transit" — removed here, since Transit
// is an assignment (where she'd be placed), not a skill (what she can do);
// this was exactly the confusion the skill/assignment split corrects.
// weekly_shifts is added centrally below, not per-employee here.
//
// off_days: previously [] for all 8 (a 7-day work week for every one of
// them) — that was never a deliberate scenario requirement, just an
// unfixed default. OFF-day COUNT is now the confirmed labor rule directly
// (DEFAULT_RULES.normalWeeklyOffDays, currently 2) — no longer derived
// from shift duration vs. an unconfirmed hours ceiling (see
// lib/labor-rules.ts and roster-generation.ts's now-unused
// offDaysCountForShift). Staggered per employee so the 7 scripted
// employees don't all share the same OFF day. Wednesday — the one day the
// scripted AT201/AT535 scenario and live scoring run against — is
// deliberately excluded from the candidate pool for all of them, so
// nothing about the scripted narrative changes.
const SCRIPTED_OFF_DAY_POOL = DAYS_WITH_DATA.filter((d) => d !== DEMO_TODAY);
function scriptedOffDays(employeeIndex: number): string[] {
  return buildStaggeredOffDays(employeeIndex, DEFAULT_RULES.normalWeeklyOffDays, SCRIPTED_OFF_DAY_POOL);
}

export const SCRIPTED_EMPLOYEES: Omit<Employee, "weekly_shifts">[] = [
  {
    id: "sara-bennis",
    name: "Sara Bennis",
    skills: ["Boarding", "Business Class"],
    assignment: "General T1 Pool",
    shift_code: "AP01",
    ...getShiftTimesAs("AP01"),
    rest_before_shift_hours: restHoursForDailyRepeatingShift("AP01"),
    weekly_hours: 24,
    is_duty_officer: false,
    off_days: scriptedOffDays(0),
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
    rest_before_shift_hours: restHoursForDailyRepeatingShift("AP02"),
    weekly_hours: 26,
    is_duty_officer: false,
    off_days: scriptedOffDays(1),
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
    rest_before_shift_hours: restHoursForDailyRepeatingShift("NR02"),
    weekly_hours: 22,
    is_duty_officer: false,
    off_days: scriptedOffDays(2),
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
    // Not a catalog code, so restHoursForDailyRepeatingShift can't be
    // called directly -- derived by hand using the same 24-duration
    // formula against his actual custom 06:00-14:00 (8h) shift: 24-8=16h,
    // comfortably above the confirmed 15h floor (unlike several of the
    // scripted employees above, whose real catalog shift falls short).
    rest_before_shift_hours: 16,
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
    rest_before_shift_hours: restHoursForDailyRepeatingShift("AP01"),
    weekly_hours: 20,
    is_duty_officer: false,
    off_days: scriptedOffDays(3),
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
    rest_before_shift_hours: restHoursForDailyRepeatingShift("JR01"),
    weekly_hours: 30,
    is_duty_officer: true,
    off_days: scriptedOffDays(4),
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
    rest_before_shift_hours: restHoursForDailyRepeatingShift("MT01"),
    weekly_hours: 30,
    is_duty_officer: false,
    off_days: scriptedOffDays(5),
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
    rest_before_shift_hours: restHoursForDailyRepeatingShift("MT02"),
    weekly_hours: 18,
    is_duty_officer: false,
    off_days: scriptedOffDays(6),
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
// CORRECTED: this pattern previously had THREE OFF days (Thursday,
// Saturday, Sunday) — an undocumented, unapproved exception to the
// confirmed normalWeeklyOffDays=2 rule that a General T1 Pool employee
// (a normal, non-fixed-cycle, non-renfort team) should never carry. Fixed
// to exactly 2 OFF days (Thursday, Sunday) while still keeping the
// day-to-day shift-code variety (MT01/AP01) this example exists to
// demonstrate. Rest between every consecutive pair of working days here
// is checked to clear the 10h minimum (Friday MT01 14:45 -> Saturday AP01
// 13:45 is 23h; every other transition is either same-code or follows an
// OFF day).
const ROTATING_SHIFT_PATTERN_A: { day: string; code: string | null }[] = [
  { day: "Monday", code: "MT01" },
  { day: "Tuesday", code: "MT01" },
  { day: "Wednesday", code: "MT01" },
  { day: "Thursday", code: "OFF" },
  { day: "Friday", code: "MT01" },
  { day: "Saturday", code: "AP01" },
  { day: "Sunday", code: "OFF" },
];

// LEGACY DEMO DATA — NOT engine output. Amine Sqalli's pattern below
// (ROTATING_SHIFT_PATTERN_A) is a hand-authored example predating the
// labor-rule/Rotation Feasibility Engine work, kept only to prove daily
// roster entries genuinely vary day-to-day. It now carries exactly 2 OFF
// days, same as every other normal (non-fixed-cycle, non-renfort)
// employee — see the correction note above. Every other employee's
// off_days in this file is produced by lib/labor-rules.ts +
// lib/rotation-feasibility.ts (foreign-company groups), the fixed JR/NT
// cycle (Transit/Leaders), or this same confirmed flat 2-OFF-days rule.
export const ROTATING_SHIFT_EMPLOYEES: Omit<Employee, "weekly_shifts">[] = [
  {
    id: "rotation-example-gate",
    name: "Amine Sqalli",
    skills: ["Gate"],
    assignment: "General T1 Pool",
    shift_code: "MT01", // matches Wednesday's entry in the pattern below
    ...getShiftTimesAs("MT01"),
    rest_before_shift_hours: restHoursForDailyRepeatingShift("MT01"),
    weekly_hours: 24,
    is_duty_officer: false,
    // off_days now truthfully matches ROTATING_SHIFT_PATTERN_A above:
    // exactly 2 OFF days (Thursday, Sunday), the same confirmed normal
    // rule every other non-fixed-cycle employee follows. No renfort
    // invoked for this employee or anyone else.
    off_days: ["Thursday", "Sunday"],
    foreign_company_authorizations: [],
    active: true,
  },
];

// AT201 and AT535 are protected — hand-authored, exact values depended on
// by 02-scenario-script.md and the test suite. Never touched by generation.
// Their seat_capacity/booked_passengers are likewise hand-set synthetic
// demo figures (same caveat as lib/flight-generator.ts's generated
// flights) — not real booking data, kept in range with the same
// normal/elevated load-factor bands the generator uses.
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
    seat_capacity: 189,
    booked_passengers: 155,
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
    seat_capacity: 189,
    booked_passengers: 181,
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
  let prevShiftStart: string | null = null;
  let prevShiftEnd: string | null = null;

  for (const entry of employee.weekly_shifts) {
    if (entry.status === "off") {
      weekly_shifts.push(entry);
      prevShiftStart = null;
      prevShiftEnd = null;
      continue;
    }

    const restAwarePlan = planForeignCompanyDay(
      employee.assignment,
      entry.day_of_week,
      FLIGHTS,
      prevShiftStart,
      prevShiftEnd,
      CONFIG.minimum_rest_hours
    );

    if (restAwarePlan) {
      if (restAwarePlan.shiftCode) {
        weekly_shifts.push({ ...entry, shift_code: restAwarePlan.shiftCode, status: "working" });
        prevShiftStart = getShiftTimesAs(restAwarePlan.shiftCode).shift_start;
        prevShiftEnd = getShiftTimesAs(restAwarePlan.shiftCode).shift_end;
      } else {
        // A real company flight exists today, but no catalog shift both
        // covers the protected window and leaves this employee rested
        // since yesterday's actual shift. CORRECTED: this used to force
        // the day to OFF — silently mutating the employee's contractual
        // pattern into an extra rest day just to make generation
        // "succeed" (the exact anti-pattern flagged as the "Air France
        // issue"). Instead, fall back to the coverage-only shift (rest
        // ignored) so the employee is genuinely scheduled to cover the
        // company's flight, and let the existing week-level rest check
        // (checkRestBetweenDays, lib/planning/validation.ts) surface the
        // real conflict as a rest_violation Plan Warning — a real,
        // visible planning conflict for a human to resolve, never masked
        // as invented rest.
        const coverageOnlyPlan = planForeignCompanyDay(employee.assignment, entry.day_of_week, FLIGHTS);
        if (coverageOnlyPlan?.shiftCode) {
          weekly_shifts.push({ ...entry, shift_code: coverageOnlyPlan.shiftCode, status: "working" });
          prevShiftStart = getShiftTimesAs(coverageOnlyPlan.shiftCode).shift_start;
          prevShiftEnd = getShiftTimesAs(coverageOnlyPlan.shiftCode).shift_end;
        } else {
          // No catalog shift covers the protected window at all, rest
          // aside — a genuine coverage gap (no shift exists, not "no
          // rested shift exists"), so OFF is the honest state here.
          weekly_shifts.push({ ...entry, shift_code: null, status: "off" });
          prevShiftStart = null;
          prevShiftEnd = null;
        }
      }
      continue;
    }

    // No company flight today — the employee's existing (baseline) shift
    // applies. CORRECTED: this branch used to also silently convert the
    // day to OFF when rest since yesterday's actual shift fell short —
    // same anti-pattern as above (mutating a contractual working day into
    // invented rest). The baseline shift is now kept as-is; any real rest
    // shortfall is left to surface as a rest_violation Plan Warning via
    // checkRestBetweenDays, exactly like every other employee's schedule.
    weekly_shifts.push(entry);
    prevShiftStart = entry.shift_code ? getShiftTimesAs(entry.shift_code).shift_start : null;
    prevShiftEnd = entry.shift_code ? getShiftTimesAs(entry.shift_code).shift_end : null;
  }

  return { ...employee, weekly_shifts };
}

// Transit and Leaders: a confirmed continuous JR -> NT -> OFF -> OFF
// cycle, not a per-week off_days set — see lib/fixed-cycle-rotation.ts.
// Generated BEFORE generateEmployees() below purely so its own index
// range starts after these, avoiding id collisions; the order here has
// no other significance.
const FIXED_CYCLE_EMPLOYEES = generateFixedCycleEmployees(SCRIPTED_EMPLOYEES.length);

// Full workforce: the 8 protected scripted employees, the fixed-cycle
// teams (Transit/Leaders), the generated pool (distributed across
// General T1 Pool, other specialized/fixed teams, and foreign-company
// groups — see employee-generator.ts), and the rotating-shift example.
// ~200 is the intended scale for this stage — not expanded further.
// Foreign-company assigned employees' weekly_shifts are then adjusted to
// match their company's actual flight schedule.
export const EMPLOYEES: Employee[] = [
  // Structural, not by-name: any scripted employee whose ASSIGNMENT uses
  // the confirmed fixed cycle (usesFixedCycleRotation -- currently
  // Transit/Leaders/Duty Officers) gets their real weekly_shifts from
  // that same cycle instead of the flat uniform-schedule model, exactly
  // like every generated fixed-cycle employee (FIXED_CYCLE_EMPLOYEES
  // below). This is what fixes the one scripted Duty Officer (a JR01
  // repeating template previously gave only 11.5h rest on every
  // consecutive working day) without special-casing them by name or id.
  // cycleOffset uses their scripted off_days.length as a stable,
  // deterministic seed for coverage variety -- no significance beyond
  // that.
  ...SCRIPTED_EMPLOYEES.map((e) => ({
    ...e,
    weekly_shifts: usesFixedCycleRotation(e.assignment)
      ? buildFixedCycleWeeklySchedule(JR_NT_OFF_OFF_CYCLE, e.off_days.length, DAYS_WITH_DATA)
      : buildUniformWeeklySchedule(e.shift_code, e.off_days, DAYS_WITH_DATA),
  })),
  ...FIXED_CYCLE_EMPLOYEES.map(({ employee, cycle, cycleOffset }) => ({
    ...employee,
    weekly_shifts: buildFixedCycleWeeklySchedule(cycle, cycleOffset, DAYS_WITH_DATA),
  })),
  ...generateEmployees(SCRIPTED_EMPLOYEES.length + FIXED_CYCLE_EMPLOYEES.length).map((e) => ({
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

// AT201's initially-assigned Boarding agent.
//
// CORRECTED: this used to list TWO employees (Sara Bennis AND Youssef El
// Amrani) both confirmed against AT201's single Boarding slot — a direct,
// hardcoded violation of the headcount invariant (Boarding total_requirement
// is 1 for a standard aircraft to Europe/Schengen), predating the Weekly
// Planning overhaul's multi-role requirement model. Sara Bennis alone now
// fills Boarding 1/1; see INITIAL_AT201_PROFILING_ASSIGNEE below for
// Youssef, moved to Profiling instead of being double-booked onto an
// already-full Boarding requirement.
export const INITIAL_AT201_ASSIGNEES = ["sara-bennis"];

// AT201's initially-assigned Profiling agent — previously incorrectly also
// held a confirmed Boarding assignment on the same flight (an overlap-
// invariant violation: Boarding and Profiling windows are the same
// protected boarding window, so one employee cannot hold both). Youssef is
// a qualified Profiling candidate (confirmed via the scoring engine), so
// this is a real, valid single confirmed duty, not a fabricated one.
export const INITIAL_AT201_PROFILING_ASSIGNEE = "youssef-el-amrani";

// Nadia's pre-planned duty that creates the live-ops conflict once AT201 is delayed.
export const INITIAL_PLANNED_DUTY = {
  employee_id: "nadia-ziani",
  task: "Care Point rotation",
  planned_start: "14:30",
};
