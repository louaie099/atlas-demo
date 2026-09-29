import { describe, it, expect } from "vitest";
import { checkMinimumOffDays, checkSeparatedOffDays, validateWeeklyPlan, PlanIssue } from "../lib/planning/validation";
import { isGenerationDrivenPopulation } from "../lib/planning/workforce-pools";
import { usesFixedCycleRotation } from "../lib/teams";
import { CONFIG } from "../lib/seed-data";
import { Employee, WeeklyShiftEntry } from "../lib/types";

/**
 * OFF/OFF PHASE 1 (2026-09-29) — regression tests for the reported bug: the
 * Planning Rules UI said OFF days were HARD-required (a fixed weekly count,
 * one consecutive block), but a generated week giving an employee only 1 OFF
 * day produced NO finding at all (checkOffDaysSeparated bailed out unless the
 * count was exactly normal_weekly_off_days, and nothing checked a floor).
 *
 * The two hard findings are split so one root cause is flagged once:
 *   - fewer than minimum_off_days_per_planning_week OFF days -> insufficient_off_days
 *   - floor met, but not ONE consecutive (cyclic) block      -> off_days_not_consecutive
 */

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const WEEK_START = "2026-01-05"; // a Monday
const OFF_DAY_TYPES = ["insufficient_off_days", "off_days_not_consecutive", "separated_off_days"];

/** `pattern` is 7 chars, W = working (with `code`), O = OFF. */
function makeEmployee(id: string, assignment: string, pattern: string, code = "MT01", overrides: Partial<Employee> = {}): Employee {
  const weekly_shifts: WeeklyShiftEntry[] = DAYS.map((d, i) => ({
    day_of_week: d,
    shift_code: pattern[i] === "W" ? code : null,
    status: pattern[i] === "W" ? "working" : "off",
  }));
  return {
    id, name: `${assignment} ${id}`, skills: [], assignment,
    shift_code: null, shift_start: null, shift_end: null, rest_before_shift_hours: null,
    weekly_hours: null, is_duty_officer: false, off_days: [], foreign_company_authorizations: [],
    active: true, weekly_shifts,
    ...overrides,
  };
}

function offDayIssues(employee: Employee, config = CONFIG): PlanIssue[] {
  return validateWeeklyPlan([], [employee], DAYS, config, WEEK_START).filter((i) => OFF_DAY_TYPES.includes(i.type));
}

// Every generation-driven population the rule must cover (see workforce-pools.ts).
const POPULATIONS = ["General T1 Pool", "Profiling", "Mesure", "Gulf Air", "Qatar Airways"];

describe("the new field reaches the runtime Config with the confirmed default", () => {
  it("minimum_off_days_per_planning_week defaults to 2, independent of normal_weekly_off_days", () => {
    expect(CONFIG.minimum_off_days_per_planning_week).toBe(2);
    expect(CONFIG.normal_weekly_off_days).toBe(2);
    expect(CONFIG.normal_off_days_consecutive).toBe(true);
  });

  it("every population used below really is generation-driven (and not fixed-cycle)", () => {
    for (const a of POPULATIONS) {
      const e = makeEmployee("x", a, "WWWWWOO");
      expect(isGenerationDrivenPopulation(e), a).toBe(true);
      expect(usesFixedCycleRotation(a), a).toBe(false);
    }
  });
});

describe.each(POPULATIONS)("generation-driven population: %s", (assignment) => {
  it("2 correctly-consecutive OFF days: no OFF-day issue at all", () => {
    for (const pattern of ["WWWWWOO", "OOWWWWW", "WWOOWWW", "OWWWWWO" /* Sun+Mon, cyclic block */]) {
      expect(offDayIssues(makeEmployee("a", assignment, pattern)), pattern).toEqual([]);
    }
  });

  it("REGRESSION: only 1 OFF day raises a HARD insufficient_off_days issue (previously silent)", () => {
    const e = makeEmployee("b", assignment, "WWWWWWO");
    const issues = offDayIssues(e);
    expect(issues).toHaveLength(1); // exactly one finding for one root cause, never also a separation finding
    expect(issues[0].type).toBe("insufficient_off_days");
    expect(issues[0].employeeId).toBe("b");
    expect(issues[0].description).toMatch(/only 1 OFF day\(s\) \(Sunday\).*hard minimum of 2/);
    expect(checkMinimumOffDays(e, DAYS, CONFIG)?.type).toBe("insufficient_off_days");
  });

  it("0 OFF days raises insufficient_off_days too", () => {
    const issues = offDayIssues(makeEmployee("c", assignment, "WWWWWWW"));
    expect(issues.map((i) => i.type)).toEqual(["insufficient_off_days"]);
    expect(issues[0].description).toMatch(/no OFF day/);
  });

  it("2 OFF days split apart, normal_off_days_consecutive=true: a HARD off_days_not_consecutive issue", () => {
    const e = makeEmployee("d", assignment, "WOWWOWW");
    const issues = offDayIssues(e);
    expect(issues.map((i) => i.type)).toEqual(["off_days_not_consecutive"]);
    expect(issues[0].description).toMatch(/Tuesday, Friday/);
    expect(checkSeparatedOffDays(e, DAYS, CONFIG)?.type).toBe("off_days_not_consecutive");
  });

  it("3 OFF days split apart are checked too (the old exactly-N bail-out skipped them)", () => {
    expect(offDayIssues(makeEmployee("e", assignment, "OOWWOWW")).map((i) => i.type)).toEqual(["off_days_not_consecutive"]);
  });

  it("with normal_off_days_consecutive=false a split block is only the soft separated_off_days recommendation — but the floor stays hard", () => {
    const soft = { ...CONFIG, normal_off_days_consecutive: false };
    expect(offDayIssues(makeEmployee("f", assignment, "WOWWOWW"), soft).map((i) => i.type)).toEqual(["separated_off_days"]);
    expect(offDayIssues(makeEmployee("g", assignment, "WWWWWWO"), soft).map((i) => i.type)).toEqual(["insufficient_off_days"]);
  });

  it("the floor follows the configured minimum, not normal_weekly_off_days", () => {
    const raised = { ...CONFIG, minimum_off_days_per_planning_week: 3 };
    expect(offDayIssues(makeEmployee("h", assignment, "WWWWWOO"), raised).map((i) => i.type)).toEqual(["insufficient_off_days"]);
    const lowered = { ...CONFIG, minimum_off_days_per_planning_week: 1 };
    expect(offDayIssues(makeEmployee("i", assignment, "WWWWWWO"), lowered)).toEqual([]);
  });
});

describe("fixed-cycle JR/NT/OFF/OFF rotation employees are exempt from both checks", () => {
  // Every 7-day view of the continuous JR -> NT -> OFF -> OFF cycle: none is
  // a single 2-day block (3 or 4 OFF days, always split in the week view).
  const CYCLE_WEEKS: [string, (string | null)[]][] = [
    ["JR NT O O JR NT O", ["JR02", "NT01", null, null, "JR02", "NT01", null]],
    ["NT O O JR NT O O", ["NT01", null, null, "JR02", "NT01", null, null]],
    ["O O JR NT O O JR", [null, null, "JR02", "NT01", null, null, "JR02"]],
    ["O JR NT O O JR NT", [null, "JR02", "NT01", null, null, "JR02", "NT01"]],
  ];

  for (const team of ["Transit", "Leaders", "Duty Officers"]) {
    for (const [label, codes] of CYCLE_WEEKS) {
      it(`${team}: ${label} is never flagged`, () => {
        const e: Employee = {
          ...makeEmployee("fc", team, "WWWWWWW", "JR02", { is_duty_officer: team === "Duty Officers" }),
          weekly_shifts: DAYS.map((d, i) => ({ day_of_week: d, shift_code: codes[i], status: codes[i] ? "working" : "off" })),
        };
        expect(usesFixedCycleRotation(e.assignment)).toBe(true);
        expect(checkMinimumOffDays(e, DAYS, CONFIG)).toBeNull();
        expect(checkSeparatedOffDays(e, DAYS, CONFIG)).toBeNull();
        expect(offDayIssues(e)).toEqual([]);
      });
    }

    it(`${team}: even a (hypothetical) 1-OFF week never trips the generation-driven floor`, () => {
      const e = makeEmployee("fc1", team, "WWWWWWO", "JR02", { is_duty_officer: team === "Duty Officers" });
      expect(checkMinimumOffDays(e, DAYS, CONFIG)).toBeNull();
      expect(offDayIssues(e)).toEqual([]);
    });
  }
});

describe("validateWeeklyPlan surfaces the findings per employee, across a mixed roster", () => {
  it("flags exactly the two broken generation-driven employees and nobody else", () => {
    const roster = [
      makeEmployee("ok-flex", "General T1 Pool", "WWWWWOO"),
      makeEmployee("one-off-profiling", "Profiling", "WWWWWWO"),
      makeEmployee("split-mesure", "Mesure", "WOWWWOW"),
      makeEmployee("ok-foreign", "Gulf Air", "OWWWWWO"),
      {
        ...makeEmployee("transit", "Transit", "WWWWWWW", "JR02"),
        weekly_shifts: DAYS.map((d, i) => {
          const c = ["JR02", "NT01", null, null, "JR02", "NT01", null][i];
          return { day_of_week: d, shift_code: c, status: c ? ("working" as const) : ("off" as const) };
        }),
      },
    ];
    const issues = validateWeeklyPlan([], roster, DAYS, CONFIG, WEEK_START).filter((i) => OFF_DAY_TYPES.includes(i.type));
    expect(issues.map((i) => [i.employeeId, i.type])).toEqual([
      ["one-off-profiling", "insufficient_off_days"],
      ["split-mesure", "off_days_not_consecutive"],
    ]);
  });
});
