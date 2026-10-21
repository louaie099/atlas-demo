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
 * 17 NAMED, STABLE employees, sized against lib/demo-poc/flights.ts's real
 * demand to reliably exercise all four PoC demonstration scenarios, not
 * for stress-testing or general UI exploration — see lib/seed-data.ts and
 * lib/demo-small/employees.ts for those. Built with the exact same real
 * engine machinery every other dataset uses (getShiftTimesAs,
 * buildStaggeredOffDays, deriveTeamRotation) — nothing about
 * eligibility/scoring/rotation is reimplemented or special-cased for this
 * dataset.
 *
 * 2026-10-21 (PoC acceptance criteria fix): Profiling headcount raised
 * from 1 to 3 so the BASELINE generated plan now achieves complete,
 * zero-gap coverage of every per-flight StaffingRequirement (Gate,
 * Boarding, Profiling, and Qatar Airways' company_config requirement) —
 * criterion 1's "zero uncovered requirements." The previous 1-person
 * Profiling team deliberately left 2 of AT502's 7 weekly instances
 * permanently, structurally uncovered as a standing "honest failure"
 * demonstration — that conflicted with criterion 1's explicit zero-gap
 * baseline requirement once the PoC's acceptance criteria were
 * formalized. The "honest failure" demonstration (criterion 4) now lives
 * entirely inside a LIVE disruption scenario instead (see
 * tests/poc-demo-dataset.test.ts's Scenario D), never in the starting
 * state. (2 Profiling-qualified people, each with 2 disjoint OFF days,
 * was tried first and verified NOT sufficient — the engine's own
 * demand-aware OFF-window water-filling, lib/planning/off-window.ts,
 * is a heuristic, not a global optimizer, and left one day with both
 * people off; 3 people closes it, empirically re-verified after the
 * change, not assumed.)
 *
 * SEPARATE, PRE-EXISTING, OUT-OF-SCOPE LIMITATION (not touched by this
 * fix, not specific to this dataset): the T1 Check-in ZONE coverage model
 * (lib/planning/checkin-zone-placement.ts /
 * lib/planning/checkin-capacity-timeline.ts) is its own distinct metric
 * from "Requirements covered"/"Staffing gaps" above — see
 * components/planning-summary-bar.tsx's own doc comment, which explicitly
 * labels it "a DIFFERENT kind of number... one zone requirement can
 * represent several flights' combined workload, not one flight+role
 * slot," and the model itself is commented "prototype/configurable demand
 * policy, not yet confirmed management policy." It derives purely from
 * whatever Stage 6 already decided for per-flight roles, with no
 * placement of its own (confirmed: zoneAssignments.length is always 0).
 * This dataset still leaves a real, engine-computed Check-in zone
 * shortfall in the early-morning/late-evening hours, same as the main and
 * small demo datasets' own documented Check-in zone gaps (see
 * lib/demo-small/employees.ts) — a known, shared, cross-dataset
 * limitation of Stage 6's own shift-code selection (confirmed: adding
 * extra pure-Check-in headcount was tried and did NOT close it — Stage 6
 * never selects an overnight/evening-reaching catalog code for anyone in
 * this dataset, a deeper scoring-engine question outside "fix POC
 * blockers only, no unrelated refactoring" for this milestone). Left
 * as-is and reported, not suppressed.
 *
 *  - General T1 Pool (11) — ordinary RAM capacity for AT501/AT502/AT503's
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
 *    actually produces from this roster. The eleventh (Yassine Alami,
 *    Gate-only, MT01) is a 2026-10-21 criterion-1 addition: with only 3
 *    early-shift Gate-qualified people (Gamal/Reda/Hanae), the OFF-window
 *    planner happened to land all three off the SAME day (Saturday),
 *    leaving only the two 08:00-start NR01 Gate+Check-in people on
 *    roster — too late to reach AT501's 06:30 Gate window, a real,
 *    engine-computed gap confirmed by a direct per-day dump. A fourth
 *    early-shift body closes it, re-verified empirically, not assumed.
 *  - Profiling (3) — covers AT502's daily Profiling requirement. Each of
 *    the three has their own 2 OFF days (Khadija: Mon/Tue, Salma: Thu/Fri,
 *    Ilham: Sat/Sun); the real engine's own demand-aware OFF-window
 *    planner (not this dataset) decides exactly who ends up rostered on
 *    which day, but with three people spread this way every one of the 7
 *    days empirically ends up with at least one Profiling-qualified
 *    person on roster — verified via a direct per-day dump of the
 *    generated plan's real assignments, not assumed from the seed data.
 *    Four of the seven days are covered by exactly one of the three,
 *    which is what makes a live delay scenario against one of those
 *    single-coverage days (not a permanent baseline shortfall) a
 *    genuinely unresolvable "no eligible replacement" case for criterion
 *    4 — see tests/poc-demo-dataset.test.ts's Scenario D.
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
  // 2026-10-21 (PoC acceptance criterion 1 fix): a fourth early-shift
  // Gate-qualified employee. With only 3 (Gamal/Reda/Hanae, all an early
  // MT0x code — AT501's 06:30-07:30 Gate window needs someone whose shift
  // actually starts that early; the two NR01 Gate+Check-in people start
  // at 08:00, too late), the demand-aware OFF-window planner's own
  // heuristic (see the Profiling section's doc comment above for the same
  // caveat) happened to land all three on the SAME day off (Saturday),
  // leaving zero early-shift Gate coverage that one day — confirmed by a
  // direct per-day dump of the generated plan, not assumed. A fourth
  // early-shift body closes it — re-verified empirically after the
  // change (see tests/poc-demo-dataset.test.ts's criterion 1 assertion).
  { id: "poc-yassine-alami", name: "Yassine Alami", skills: ["Gate"], shift_code: "MT01", weekly_hours: 24 },
];

/**
 * Profiling (3) — 2026-10-21 (PoC acceptance criterion 1 fix): raised
 * from 1 to 3 Profiling-qualified employees, each with explicitly chosen
 * OFF days (not run through buildStaggeredOffDays's generic rotation —
 * see below), so the baseline plan has zero Profiling gaps across all 7
 * days of the week. The generation engine's own demand-aware OFF-window
 * planner (lib/planning/specialized-team-generation.ts's
 * planSpecializedOffWindows, same machinery as off-window.ts's
 * cross-population water-filling) ultimately decides each week's REAL
 * per-day roster from these three people's inputs — it does NOT simply
 * honor the off_days below verbatim (confirmed by direct inspection of
 * generated plan output). Two people with perfectly disjoint 2-day OFF
 * blocks (Mon/Tue + Thu/Fri) were tried FIRST and found NOT sufficient:
 * the planner's own heuristic (a water-filling refinement, not a global
 * optimizer) still left one day with both people off, re-verified by
 * dumping the actual generated per-day Profiling assignment, not assumed
 * from the seed. A third person closes it — every one of the 7 days
 * empirically has at least one Profiling-qualified person rostered,
 * closing what used to be a permanent, headcount-forced baseline gap
 * (the dataset's previous 1-person design deliberately left 2 days a week
 * uncovered as Scenario D's "honest failure" case — see
 * tests/poc-demo-dataset.test.ts for the replacement: a genuinely
 * UNRESOLVABLE gap is now demonstrated via a LIVE disruption on one of
 * the days only a single Profiling-qualified person ends up rostered,
 * never by a standing structural shortfall in the baseline plan itself,
 * per the explicit "zero uncovered requirements" baseline requirement).
 * All three carry a real second RAM skill (Boarding) so idle time outside
 * AT502's Profiling window is ordinary reachable capacity, consistent
 * with every other dataset's 2026-10-05 correction (see
 * lib/demo-small/employees.ts's module comment for the full explanation
 * of why the engine already supports this).
 */
const PROFILING: Omit<Employee, "weekly_shifts">[] = [
  buildEmployee({
    id: "poc-khadija-mernissi",
    name: "Khadija Mernissi",
    skills: ["Profiling", "Boarding"],
    assignment: "Profiling",
    shift_code: "NR02",
    weekly_hours: 24,
    off_days: ["Monday", "Tuesday"],
  }),
  buildEmployee({
    id: "poc-salma-idrissi",
    name: "Salma Idrissi",
    skills: ["Profiling", "Boarding"],
    assignment: "Profiling",
    shift_code: "NR02",
    weekly_hours: 24,
    off_days: ["Thursday", "Friday"],
  }),
  buildEmployee({
    id: "poc-ilham-benkirane",
    name: "Ilham Benkirane",
    skills: ["Profiling", "Boarding"],
    assignment: "Profiling",
    shift_code: "NR02",
    weekly_hours: 24,
    off_days: ["Saturday", "Sunday"],
  }),
];

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
  // PROFILING is built directly above (explicit, disjoint off-days,
  // assignment already set to "Profiling"), not routed through
  // buildFlatRuleEmployees's generic stagger — see its own doc comment
  // for why.
  ...PROFILING,
];

export const POC_DEMO_QATAR_AIRWAYS_EMPLOYEES: Omit<Employee, "weekly_shifts">[] = buildForeignCompanyGroup(
  "Qatar Airways",
  QATAR_AIRWAYS_NAMES,
  "NR01",
  24
);

// 11 General T1 Pool + 3 Profiling + 3 Qatar Airways = 17 employees total.
export const POC_DEMO_EMPLOYEE_COUNT = POC_DEMO_FLAT_RULE_EMPLOYEES.length + POC_DEMO_QATAR_AIRWAYS_EMPLOYEES.length;
