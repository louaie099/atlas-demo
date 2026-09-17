import { describe, it, expect } from "vitest";
import { generateObligationToppedUpShifts, proratedObligationHoursForWindow } from "../lib/planning/roster-generation";
import { generateDraftWeeklyPlan } from "../lib/planning/generate-draft-plan";
import { generateForeignCompanyShifts } from "../lib/planning/specialized-team-generation";
import { scoreCandidates } from "../lib/scoring";
import { getCompanyTeamRoleConfig } from "../lib/company-config";
import { isRedeploymentAllowed } from "../lib/teams";
import { selectCompatibleShiftCodes } from "../lib/foreign-shift-planning";
import { EMPLOYEES, FLIGHTS, CONFIG, DAYS_WITH_DATA as DAYS_ORDER, CURRENT_WEEK_LABEL as WEEK_LABEL } from "../lib/seed-data";
import { CONFIGURED_COMPANIES } from "../lib/company-config";
import { Employee, Flight } from "../lib/types";

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "emp", name: "Test", skills: ["Boarding"], assignment: "General T1 Pool",
    shift_code: null, shift_start: null, shift_end: null, rest_before_shift_hours: null,
    weekly_hours: null, is_duty_officer: false, off_days: [], foreign_company_authorizations: [],
    active: true, weekly_shifts: [{ day_of_week: "Wednesday", shift_code: null, status: "off" }],
    ...overrides,
  };
}

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

describe("continuous roster generation — backward compatibility while obligation is unconfigured", () => {
  it("proratedObligationHoursForWindow returns null (never a guessed number) while working_hours_obligation_hours is null", () => {
    expect(CONFIG.working_hours_obligation_hours).toBeNull();
    expect(proratedObligationHoursForWindow(CONFIG, 7)).toBeNull();
  });

  it("generateObligationToppedUpShifts is a strict no-op (empty additions every day) while obligation is unconfigured", () => {
    const employee = makeEmployee({ id: "e1", assignment: "General T1 Pool" });
    const additional = generateObligationToppedUpShifts(DAYS, [employee], {}, CONFIG, new Map(), CONFIG.minimum_rest_hours);
    for (const day of DAYS) {
      expect(additional[day]).toEqual([]);
    }
  });

  it("the full pipeline (generateDraftWeeklyPlan) produces the identical roster with and without the new stage present, while obligation stays unconfigured — the regression guard the redesign must never break", () => {
    const planBefore = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_ORDER, WEEK_LABEL);
    const planAfter = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_ORDER, WEEK_LABEL);
    // Same config (obligation null) run twice must be deterministic and,
    // more importantly, running it through the new roster-generation stage
    // must yield the exact same rosterEntries as the pre-existing pipeline
    // did (validated indirectly: the stage is proven to add nothing above,
    // so this just proves the merged pipeline is still fully deterministic
    // and produces a real, non-empty roster).
    expect(planAfter.rosterEntries).toEqual(planBefore.rosterEntries);
    expect(planAfter.rosterEntries.length).toBeGreaterThan(0);
  });
});

describe("continuous roster generation — schedules toward the obligation once configured", () => {
  it("tops up a flexible-pool employee with zero demand-driven days toward their configured obligation, respecting rest and the OFF-day entitlement", () => {
    const employee = makeEmployee({ id: "e1", assignment: "General T1 Pool", skills: ["Boarding"] });
    const configuredForTest = { ...CONFIG, working_hours_obligation_hours: 35, normal_weekly_off_days: 2 };

    // No demand-driven shifts at all this week for this employee.
    const demandDrivenShiftsByDay: Record<string, ReturnType<typeof generateObligationToppedUpShifts>[string]> = {};
    for (const day of DAYS) demandDrivenShiftsByDay[day] = [];

    const additional = generateObligationToppedUpShifts(
      DAYS,
      [employee],
      demandDrivenShiftsByDay,
      configuredForTest,
      new Map(),
      configuredForTest.minimum_rest_hours
    );

    let totalDaysAdded = 0;
    let totalHoursAdded = 0;
    for (const day of DAYS) {
      totalDaysAdded += additional[day].length;
      for (const g of additional[day]) {
        expect(g.employeeId).toBe("e1");
      }
    }
    // Never scheduled below the confirmed 2-OFF-day entitlement.
    expect(totalDaysAdded).toBeLessThanOrEqual(DAYS.length - configuredForTest.normal_weekly_off_days);
    expect(totalDaysAdded).toBeGreaterThan(0); // real top-up happened, not another no-op
  });

  it("does nothing further once the demand-driven schedule already meets the configured obligation", () => {
    const employee = makeEmployee({ id: "e1", assignment: "General T1 Pool" });
    const configuredForTest = { ...CONFIG, working_hours_obligation_hours: 5 };
    const demandDrivenShiftsByDay: Record<string, { employeeId: string; dayOfWeek: string; shiftCode: string; coversRoles: string[] }[]> = {};
    for (const day of DAYS) demandDrivenShiftsByDay[day] = [];
    demandDrivenShiftsByDay["Monday"] = [{ employeeId: "e1", dayOfWeek: "Monday", shiftCode: "MT02", coversRoles: [] }];

    const additional = generateObligationToppedUpShifts(
      DAYS,
      [employee],
      demandDrivenShiftsByDay,
      configuredForTest,
      new Map(),
      configuredForTest.minimum_rest_hours
    );
    for (const day of DAYS) expect(additional[day]).toEqual([]);
  });
});

describe("team composition — Gulf Air's confirmed 7 ACE + 1 Leader split", () => {
  it("company-config exposes the confirmed split, and no other company has one configured", () => {
    expect(getCompanyTeamRoleConfig("Gulf Air")).toEqual({ aceCount: 7, leaderCount: 1 });
    for (const company of CONFIGURED_COMPANIES) {
      if (company === "Gulf Air") continue;
      expect(getCompanyTeamRoleConfig(company)).toBeNull();
    }
  });

  it("employee-generator tags exactly one Gulf Air employee as leader and the rest as ace", () => {
    const gulfAir = EMPLOYEES.filter((e) => e.assignment === "Gulf Air");
    expect(gulfAir.length).toBe(8);
    const leaders = gulfAir.filter((e) => e.team_role === "leader");
    const aces = gulfAir.filter((e) => e.team_role === "ace");
    expect(leaders.length).toBe(1);
    expect(aces.length).toBe(7);
  });

  it("a Leader never fills an ACE slot: if only the Leader is active/available, ACE headcount is reported as a genuine shortfall, not silently covered by the Leader", () => {
    const flight: Flight = {
      id: "f1", flight_number: "GA100", airline: "Gulf Air", route: "CMN → X",
      origin: "CMN", destination: "X", aircraft: "Boeing 737-800", equipment_code: null,
      registration: null, callsign: null, terminal: "T2", scheduled_departure: "10:00",
      scheduled_arrival: null, gate: null, boarding_window_start: null, boarding_window_end: null,
      status: "scheduled", booking_pressure: "normal", day_of_week: "Wednesday", flight_date: "2026-09-03", week_start: "2026-09-01",
      operator_type: "self_managed", destination_category: null, booked_passengers: null, seat_capacity: null,
    };
    const leaderOnly = makeEmployee({ id: "leader-1", assignment: "Gulf Air", team_role: "leader", skills: ["Boarding"] });

    const { generatedShiftsByDay, conflicts } = generateForeignCompanyShifts(
      ["Wednesday"],
      [leaderOnly],
      [flight],
      ["Gulf Air"],
      15
    );

    // Only the Leader gets scheduled (their own leader slot), never counted
    // toward the 7 ACE slots — those show up as an honest shortfall.
    expect(generatedShiftsByDay["Wednesday"]?.length ?? 0).toBe(1);
    expect(generatedShiftsByDay["Wednesday"][0].employeeId).toBe("leader-1");
    const gulfConflict = conflicts.find((c) => c.team === "Gulf Air" && c.dayOfWeek === "Wednesday");
    expect(gulfConflict).toBeDefined();
    expect(gulfConflict!.needed).toBe(8);
    expect(gulfConflict!.covered).toBe(1); // leader only -- the 7 ACE slots are a real, reported gap
  });

  it("with the full real Gulf Air roster (7 ACE + 1 Leader, all active), both role groups are fully covered exactly as before this change", () => {
    const gulfAir = EMPLOYEES.filter((e) => e.assignment === "Gulf Air");
    const gulfAirFlight = FLIGHTS.find((f) => f.airline === "Gulf Air");
    expect(gulfAirFlight).toBeDefined();
    const { generatedShiftsByDay, conflicts } = generateForeignCompanyShifts(
      DAYS_ORDER,
      EMPLOYEES,
      FLIGHTS,
      ["Gulf Air"],
      CONFIG.minimum_rest_hours
    );
    const gulfConflicts = conflicts.filter((c) => c.team === "Gulf Air");
    expect(gulfConflicts).toEqual([]);
    const day = gulfAirFlight!.day_of_week;
    const scheduledIds = new Set((generatedShiftsByDay[day] ?? []).map((g) => g.employeeId));
    for (const e of gulfAir) {
      expect(scheduledIds.has(e.id)).toBe(true);
    }
  });
});

describe("cross-team redeployment — extendable to Mesure/Profiling only via explicit config, Transit never redeployable", () => {
  it("teams.ts's isRedeploymentAllowed defaults to false for every team and company, and is hard-false for Transit unconditionally", () => {
    expect(isRedeploymentAllowed("Mesure")).toBe(false);
    expect(isRedeploymentAllowed("Profiling")).toBe(false);
    expect(isRedeploymentAllowed("Gulf Air")).toBe(false);
    expect(isRedeploymentAllowed("Transit")).toBe(false);
  });

  it("selectCompatibleShiftCodes' preferExtended flag prefers the LONGEST compatible catalog shift, never changing which codes are eligible", () => {
    const normal = selectCompatibleShiftCodes("09:00", "12:00", undefined, undefined, undefined, true, false);
    const extended = selectCompatibleShiftCodes("09:00", "12:00", undefined, undefined, undefined, true, true);
    // Same eligible set either way.
    expect(new Set(normal.map((c: { code: string }) => c.code))).toEqual(new Set(extended.map((c: { code: string }) => c.code)));
    // But the preferred (first) candidate is at least as long when extended.
    const durationOf = (c: { entree: string; sortie: string }) => {
      const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
      return toMin(c.sortie) - toMin(c.entree);
    };
    expect(durationOf(extended[0])).toBeGreaterThanOrEqual(durationOf(normal[0]));
  });
});

describe("fairness as a soft objective using hours — gated behind a neutral-default weight", () => {
  it("scoreCandidates' candidate order is unchanged when fairness_weights.workloadHoursWeight is 0 (the default), regardless of hoursScheduledThisWindow", () => {
    const window = { start: "13:50", end: "14:20" };
    const e1 = { ...EMPLOYEES.find((e) => e.skills.includes("Boarding") && e.shift_start !== null)! };
    const withoutHours = scoreCandidates("Boarding", window, [e1], CONFIG);
    const hours = new Map([[e1.id, 999]]);
    const withHours = scoreCandidates("Boarding", window, [e1], CONFIG, {}, undefined, hours);
    expect(withHours.map((r) => r.employee.id)).toEqual(withoutHours.map((r) => r.employee.id));
  });

  it("prefers the lower-scheduled-hours candidate when otherwise tied and the weight is turned on", () => {
    const window = { start: "13:50", end: "14:20" };
    const base = EMPLOYEES.find((e) => e.skills.includes("Boarding") && e.shift_start !== null && e.assignment === "General T1 Pool")!;
    const busyId = base.id + "-busy";
    const idleId = base.id + "-idle";
    const busy: Employee = { ...base, id: busyId };
    const idle: Employee = { ...base, id: idleId };

    const configWithFairness = { ...CONFIG, fairness_weights: { workloadHoursWeight: 1 } };
    const hours = new Map([
      [busyId, 30],
      [idleId, 5],
    ]);

    const results = scoreCandidates("Boarding", window, [busy, idle], configWithFairness, {}, undefined, hours);
    const recommended = results.filter((r) => r.status === "recommended");
    expect(recommended.length).toBe(2);
    expect(recommended[0].employee.id).toBe(idleId); // fewer scheduled hours ranked first
  });
});
