import { Employee } from "../types";
import { getShiftTimesAs, restHoursForDailyRepeatingShift, LEGACY_BASELINE_DATE } from "../shift-templates";
import { buildStaggeredOffDays } from "../roster-generation";
import { deriveTeamRotation, DemandDay, RotationInfeasibleError } from "../rotation-feasibility";
import { getCompanyRequiredAgents } from "../company-config";
import { resolveDefaultLaborRules } from "../labor-rules";
import { pocDemoCompanyOperatingDays } from "./flights";

/**
 * POC DEMO DATASET — workforce side.
 *
 * 14 NAMED, STABLE employees, sized against lib/demo-poc/flights.ts's real
 * demand to reliably exercise all four PoC demonstration scenarios
 * (docs/ATLAS_POC_PLAN.md Section 6), not for stress-testing or general
 * UI exploration — see lib/seed-data.ts and lib/demo-small/employees.ts
 * for those. Built with the exact same real engine machinery every other
 * dataset uses (getShiftTimesAs, buildStaggeredOffDays,
 * deriveTeamRotation) — nothing about eligibility/scoring/rotation is
 * reimplemented or special-cased for this dataset.
 *
 *  - General T1 Pool (10) — ordinary RAM capacity for AT501/AT502/AT503's
 *    universal Gate + Boarding demand. Shift codes are baseline anchors
 *    only (rest-hour calc, off-day staggering) — the real day-to-day code
 *    is demand-driven, assigned fresh each day by the real Stage 6 shift
 *    generator (lib/planning/shift-generation.ts), exactly like every
 *    other dataset; nothing here pins a specific employee to a specific
 *    day's shift. This mix of skills/baseline codes was verified (see
 *    tests/poc-demo-dataset.test.ts's Scenario B/C test) to make Stage 6 +
 *    Stage 9 genuinely invalidate exactly the Gate incumbent's AT503/
 *    Wednesday assignment after the live delay while leaving Boarding's
 *    untouched, and to leave at least one real "recommended" and one real
 *    "flagged" replacement candidate for the vacant Gate slot — nothing
 *    about this outcome is hand-asserted; it's what the real engine
 *    actually produces from this roster.
 *  - Profiling (1) — covers AT502's daily Profiling requirement. A single
 *    person working a normal 5-day week (2 OFF days, the same confirmed
 *    rule every employee here follows) can physically cover at most 5 of
 *    AT502's 7 weekly instances, so at least 2 days are a REAL,
 *    headcount-forced Profiling gap (Scenario D) regardless of which 2
 *    days the engine's own OFF-day optimizer picks.
 *  - Qatar Airways (3) — real demand: 2 agents/flight, Mon/Wed/Fri only
 *    (see flights.ts's QR601), headcount/off-days derived through the same
 *    Rotation Feasibility Engine every other dataset's foreign-company
 *    groups use (deriveTeamRotation), never hand-picked.
 */

const ALL_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const LABOR_RULES = resolveDefaultLaborRules();
const restBeforeShiftFor = (code: string) => restHoursForDailyRepeatingShift(code, LEGACY_BASELINE_DATE);

function buildEmployee(partial: {
  id: string;
  name: string;
  skills: string[];
  assignment: string;
  shift_code: string;
  weekly_hours: number;
  off_days: string[];
  foreign_company_authorizations?: string[];
}): Omit<Employee, "weekly_shifts"> {
  const { shift_start, shift_end } = getShiftTimesAs(partial.shift_code, LEGACY_BASELINE_DATE);
  return {
    id: partial.id,
    name: partial.name,
    skills: partial.skills,
    assignment: partial.assignment,
    shift_code: partial.shift_code,
    shift_start,
    shift_end,
    rest_before_shift_hours: restBeforeShiftFor(partial.shift_code),
    weekly_hours: partial.weekly_hours,
    is_duty_officer: false,
    off_days: partial.off_days,
    foreign_company_authorizations: partial.foreign_company_authorizations ?? [],
    active: true,
  };
}

/**
 * General T1 Pool (10): gamal/reda (Gate only), amina/aaliya/hanae (Gate +
 * Check-in), karim/widad/othmane (Boarding + Check-in), nisrine/youssef
 * (Check-in + Weight Control only). Who specifically ends up as the Wed
 * AT503 Gate/Boarding incumbent, and who ends up "recommended" vs
 * "flagged" after the delay, is Stage 6/9's own real, demand-driven
 * decision — see tests/poc-demo-dataset.test.ts, which asserts the
 * outcome (one invalidated incumbent, one unaffected incumbent, at least
 * one recommended + one flagged replacement) without asserting WHO.
 */
const GENERAL_T1_POOL = [
  { id: "poc-gamal-tazi", name: "Gamal Tazi", skills: ["Gate"], shift_code: "MT03", weekly_hours: 24 },
  { id: "poc-reda-amrani", name: "Reda Amrani", skills: ["Gate"], shift_code: "MT03", weekly_hours: 24 },
  { id: "poc-amina-ziani", name: "Amina Ziani", skills: ["Gate", "Check-in"], shift_code: "NR01", weekly_hours: 24 },
  { id: "poc-aaliya-tazi", name: "Aaliya Tazi", skills: ["Gate", "Check-in"], shift_code: "NR01", weekly_hours: 24 },
  { id: "poc-hanae-sqalli", name: "Hanae Sqalli", skills: ["Gate", "Check-in"], shift_code: "MT01", weekly_hours: 24 },
  { id: "poc-karim-senhaji", name: "Karim Senhaji", skills: ["Boarding", "Check-in"], shift_code: "NR02", weekly_hours: 24 },
  { id: "poc-widad-chraibi", name: "Widad Chraibi", skills: ["Boarding", "Check-in"], shift_code: "AP01", weekly_hours: 24 },
  { id: "poc-othmane-rifai", name: "Othmane Rifai", skills: ["Boarding", "Check-in"], shift_code: "NR01", weekly_hours: 24 },
  { id: "poc-nisrine-fassi", name: "Nisrine Fassi", skills: ["Check-in", "Weight Control"], shift_code: "MT03", weekly_hours: 24 },
  { id: "poc-youssef-benali", name: "Youssef Benali", skills: ["Check-in", "Weight Control"], shift_code: "NR01", weekly_hours: 24 },
];

/**
 * Profiling (1) — the single Profiling-qualified employee, Scenario D's
 * genuinely unresolvable gap. Also carries a real second RAM skill
 * (Boarding) so idle time outside AT502's Profiling window is ordinary
 * reachable capacity, consistent with every other dataset's 2026-10-05
 * correction (see lib/demo-small/employees.ts's module comment for the
 * full explanation of why the engine already supports this).
 */
const PROFILING = [{ id: "poc-khadija-mernissi", name: "Khadija Mernissi", skills: ["Profiling", "Boarding"], shift_code: "NR02", weekly_hours: 24 }];

/** Builds the flat-rule (non-foreign) employees above, each staggered 2 OFF days/week, Wednesday kept working (so AT503's Wednesday delay scenario always has real incumbents on roster). */
function buildFlatRuleEmployees(
  specs: { id: string; name: string; skills: string[]; shift_code: string; weekly_hours: number }[],
  assignment: string
): Omit<Employee, "weekly_shifts">[] {
  const candidatePool = ALL_DAYS.filter((d) => d !== "Wednesday");
  return specs.map((spec, n) =>
    buildEmployee({
      ...spec,
      assignment,
      off_days: buildStaggeredOffDays(n, LABOR_RULES.normalWeeklyOffDays, candidatePool),
    })
  );
}

/**
 * Foreign-company group builder — same approach as every other dataset's
 * own (e.g. lib/demo-small/employees.ts's buildForeignCompanyGroup):
 * headcount/off-days derived through the real Rotation Feasibility Engine
 * off the company's REAL flight days, never hand-picked, and never a
 * silently-invented fallback if infeasible.
 */
function buildForeignCompanyGroup(
  assignment: string,
  names: { id: string; name: string }[],
  shiftCode: string,
  weeklyHours: number
): Omit<Employee, "weekly_shifts">[] {
  const flightDays = pocDemoCompanyOperatingDays(assignment);
  const requiredAgents = getCompanyRequiredAgents(assignment);
  if (requiredAgents === undefined) {
    throw new Error(`"${assignment}" has no confirmed company_config headcount — lib/company-config.ts must define it before the PoC demo can roster this group.`);
  }
  const demand: DemandDay[] = ALL_DAYS.map((d) => ({ dayOfWeek: d, requiredAgents: flightDays.includes(d) ? requiredAgents : 0 }));

  const count = names.length;
  const result = deriveTeamRotation(count, demand, ALL_DAYS, LABOR_RULES.normalWeeklyOffDays, undefined, 4, LABOR_RULES.maxConsecutiveOffDays);
  if (!result.feasible || !result.candidate) {
    throw new RotationInfeasibleError(assignment, count, demand, result.reason ?? "No feasible rotation found.", LABOR_RULES.normalWeeklyOffDays);
  }

  const offDaysByMember: string[][] = [];
  for (const group of result.candidate.groups) {
    for (let k = 0; k < group.size; k++) offDaysByMember.push(group.offDays);
  }

  return names.map((n, i) =>
    buildEmployee({
      id: n.id,
      name: n.name,
      skills: ["Boarding"],
      assignment,
      shift_code: shiftCode,
      weekly_hours: weeklyHours,
      off_days: offDaysByMember[i],
      foreign_company_authorizations: [assignment],
    })
  );
}

/** Qatar Airways (3) — real demand: 2 agents/flight, Mon/Wed/Fri only. */
const QATAR_AIRWAYS_NAMES = [
  { id: "poc-nawal-benjelloun", name: "Nawal Benjelloun" },
  { id: "poc-mehdi-ouazzani", name: "Mehdi Ouazzani" },
  { id: "poc-siham-lahrichi", name: "Siham Lahrichi" },
];

export const POC_DEMO_FLAT_RULE_EMPLOYEES: Omit<Employee, "weekly_shifts">[] = [
  ...buildFlatRuleEmployees(GENERAL_T1_POOL, "General T1 Pool"),
  ...buildFlatRuleEmployees(PROFILING, "Profiling"),
];

export const POC_DEMO_QATAR_AIRWAYS_EMPLOYEES: Omit<Employee, "weekly_shifts">[] = buildForeignCompanyGroup(
  "Qatar Airways",
  QATAR_AIRWAYS_NAMES,
  "NR01",
  24
);

// 10 General T1 Pool + 1 Profiling + 3 Qatar Airways = 14 employees total.
export const POC_DEMO_EMPLOYEE_COUNT = POC_DEMO_FLAT_RULE_EMPLOYEES.length + POC_DEMO_QATAR_AIRWAYS_EMPLOYEES.length;
