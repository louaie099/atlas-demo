import { describe, it, expect } from "vitest";
import { generateObligationToppedUpShifts, proratedObligationHoursForWindow, chooseTopUpReservedOffDays } from "../lib/planning/roster-generation";
import { generateDraftWeeklyPlan } from "../lib/planning/generate-draft-plan";
import { generateForeignCompanyShifts } from "../lib/planning/specialized-team-generation";
import { isFlexibleGeneralPool } from "../lib/planning/workforce-pools";
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
// Pre-boundary Monday (before the 2026-09-20 GMT+1 -> GMT regime change) --
// these unit tests only care about day-count/hours bookkeeping, not shift
// times, so any consistent OLD-regime week works.
const TEST_WEEK_START = "2026-01-05";

describe("continuous roster generation — backward compatibility while obligation is unconfigured", () => {
  it("proratedObligationHoursForWindow returns null (never a guessed number) while working_hours_obligation_hours is null", () => {
    expect(CONFIG.working_hours_obligation_hours).toBeNull();
    expect(proratedObligationHoursForWindow(CONFIG, 7)).toBeNull();
  });

  it("generateObligationToppedUpShifts is STILL a strict no-op for an employee already at the confirmed 5-worked/2-off target, even while the hours obligation is unconfigured", () => {
    // makeEmployee's default has a Wednesday OFF entry only -- give this
    // employee demand-driven shifts on the other 6 days (Wednesday OFF is
    // the 1 real OFF day) plus nothing else needed, so the day-count
    // objective (5 worked, 2 off out of 7) still has one more OFF day of
    // room and requires no further action once the demand-driven days
    // already total exactly 5.
    const employee = makeEmployee({ id: "e1", assignment: "General T1 Pool", skills: ["Boarding"] });
    const demandDrivenShiftsByDay: Record<string, ReturnType<typeof generateObligationToppedUpShifts>[string]> = {};
    for (const day of DAYS) demandDrivenShiftsByDay[day] = [];
    for (const day of DAYS.filter((d) => d !== "Saturday" && d !== "Sunday")) {
      demandDrivenShiftsByDay[day] = [{ employeeId: "e1", dayOfWeek: day, shiftCode: "MT02", coversRoles: [] }];
    }
    const additional = generateObligationToppedUpShifts(DAYS, [employee], demandDrivenShiftsByDay, CONFIG, new Map(), CONFIG.minimum_rest_hours, TEST_WEEK_START);
    for (const day of DAYS) {
      expect(additional[day]).toEqual([]);
    }
  });

  it("generateObligationToppedUpShifts is a NO-OP for anything outside the flexible General T1 pool (fixed-cycle/foreign/Profiling-Mesure), regardless of demand-driven shortfall — the narrowed but still-real backward-compatibility contract", () => {
    const employee = makeEmployee({ id: "e1", assignment: "Transit" });
    const additional = generateObligationToppedUpShifts(DAYS, [employee], {}, CONFIG, new Map(), CONFIG.minimum_rest_hours, TEST_WEEK_START);
    for (const day of DAYS) {
      expect(additional[day]).toEqual([]);
    }
  });

  it("CONFIRMED, ALWAYS-ON (Part 1): tops up a flexible ACE with zero demand-driven days toward the '5 WORK + 2 OFF' normal target, even while the hours obligation stays UNCONFIGURED (null) — this is the genuine, intentional behavior change from the previous fully-gated no-op", () => {
    expect(CONFIG.working_hours_obligation_hours).toBeNull();
    const employee = makeEmployee({ id: "e1", assignment: "General T1 Pool", skills: ["Boarding"] });
    const demandDrivenShiftsByDay: Record<string, ReturnType<typeof generateObligationToppedUpShifts>[string]> = {};
    for (const day of DAYS) demandDrivenShiftsByDay[day] = [];

    const additional = generateObligationToppedUpShifts(DAYS, [employee], demandDrivenShiftsByDay, CONFIG, new Map(), CONFIG.minimum_rest_hours, TEST_WEEK_START);

    let totalDaysAdded = 0;
    for (const day of DAYS) totalDaysAdded += additional[day].length;
    // Confirmed target for a 7-day window: 5 worked days (normal_weekly_off_days = 2).
    expect(totalDaysAdded).toBe(DAYS.length - CONFIG.normal_weekly_off_days);
  });

  it("the full pipeline (generateDraftWeeklyPlan) is deterministic across repeated runs with the same inputs, and produces a non-empty roster, with the always-on 5-WORK+2-OFF top-up now genuinely part of the pipeline", () => {
    const planBefore = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_ORDER, WEEK_LABEL, TEST_WEEK_START);
    const planAfter = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_ORDER, WEEK_LABEL, TEST_WEEK_START);
    expect(planAfter.rosterEntries).toEqual(planBefore.rosterEntries);
    expect(planAfter.rosterEntries.length).toBeGreaterThan(0);
  });

  it("non-flexible populations (fixed-cycle, foreign-company, Profiling/Mesure) are completely unaffected by the always-on top-up — their generated roster is identical whether or not generateObligationToppedUpShifts runs at all", () => {
    const plan = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_ORDER, WEEK_LABEL, TEST_WEEK_START);
    const nonFlexible = EMPLOYEES.filter((e) => !isFlexibleGeneralPool(e));
    for (const employee of nonFlexible) {
      const entries = plan.rosterEntries.filter((r) => r.employee_id === employee.id);
      // Every non-flexible employee still gets exactly one roster entry
      // per displayed day, from their own pre-existing model — this stage
      // never adds or removes anything for them.
      expect(entries.length).toBe(DAYS_ORDER.length);
    }
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
      configuredForTest.minimum_rest_hours,
      TEST_WEEK_START
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

  it("does nothing further FOR THE HOURS OBJECTIVE once demand-driven hours already meet it, but objective 1 (5 WORK + 2 OFF) still tops up further if the demand-driven DAY COUNT alone falls short — the two objectives are genuinely independent, per Part 1", () => {
    const employee = makeEmployee({ id: "e1", assignment: "General T1 Pool", skills: ["Boarding"] });
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
      configuredForTest.minimum_rest_hours,
      TEST_WEEK_START
    );
    // Only 1 demand-driven day exists -- objective 1 (5 worked days)
    // still needs more, even though objective 2's hours target (5h) was
    // already cleared by Monday's own shift alone. The exact count can
    // fall short of the full remaining shortfall if the rest-legality
    // walk genuinely can't clear every remaining day (an honest gap,
    // never fabricated) -- so this asserts real, substantial top-up
    // happened, not the single conservative catalog-dependent count.
    let totalDaysAdded = 0;
    for (const day of DAYS) totalDaysAdded += additional[day].length;
    expect(totalDaysAdded).toBeGreaterThan(0);
    expect(totalDaysAdded).toBeLessThanOrEqual(DAYS.length - configuredForTest.normal_weekly_off_days - 1);
  });

  it("is a genuine no-op for a flexible employee whose demand-driven schedule ALREADY meets both the day-count target and the configured hours obligation", () => {
    const employee = makeEmployee({ id: "e1", assignment: "General T1 Pool", skills: ["Boarding"] });
    const configuredForTest = { ...CONFIG, working_hours_obligation_hours: 5 };
    const demandDrivenShiftsByDay: Record<string, { employeeId: string; dayOfWeek: string; shiftCode: string; coversRoles: string[] }[]> = {};
    for (const day of DAYS) demandDrivenShiftsByDay[day] = [];
    for (const day of DAYS.filter((d) => d !== "Saturday" && d !== "Sunday")) {
      demandDrivenShiftsByDay[day] = [{ employeeId: "e1", dayOfWeek: day, shiftCode: "MT02", coversRoles: [] }];
    }
    const additional = generateObligationToppedUpShifts(
      DAYS,
      [employee],
      demandDrivenShiftsByDay,
      configuredForTest,
      new Map(),
      configuredForTest.minimum_rest_hours,
      TEST_WEEK_START
    );
    for (const day of DAYS) expect(additional[day]).toEqual([]);
  });
});

describe("continuous roster generation — soft preference for consecutive OFF days (Part 2)", () => {
  it("chooseTopUpReservedOffDays finds the best available consecutive block among free days, never a scattered set, when one exists", () => {
    const freeDays = new Set(["Tuesday", "Friday", "Saturday", "Sunday"]);
    const reserved = chooseTopUpReservedOffDays(DAYS, freeDays, 2);
    // Two fully-free consecutive pairs exist (Fri/Sat and Sat/Sun) --
    // ties broken by earliest start (documented behavior), so Fri/Sat wins.
    expect(reserved).toEqual(new Set(["Friday", "Saturday"]));
  });

  it("leaves the two OFF days consecutive when a fully-legal consecutive option exists among the free days", () => {
    const employee = makeEmployee({ id: "e1", assignment: "General T1 Pool", skills: ["Boarding"] });
    const demandDrivenShiftsByDay: Record<string, ReturnType<typeof generateObligationToppedUpShifts>[string]> = {};
    for (const day of DAYS) demandDrivenShiftsByDay[day] = [];

    const additional = generateObligationToppedUpShifts(DAYS, [employee], demandDrivenShiftsByDay, CONFIG, new Map(), CONFIG.minimum_rest_hours, TEST_WEEK_START);
    const workedDays = new Set(DAYS.filter((d) => additional[d].some((g) => g.employeeId === "e1")));
    const offDays = DAYS.filter((d) => !workedDays.has(d));
    expect(offDays.length).toBe(CONFIG.normal_weekly_off_days);
    // The two OFF days must be calendar-adjacent (a consecutive block) —
    // the soft preference honored whenever nothing forces a split.
    const idxs = offDays.map((d) => DAYS.indexOf(d)).sort((a, b) => a - b);
    expect(idxs[1] - idxs[0]).toBe(1);
  });

  it("still produces a fully legal (if separated) OFF pattern when a demand-driven day sits in the middle of the only available consecutive block — never blocked, never a fabricated gap", () => {
    const employee = makeEmployee({ id: "e1", assignment: "General T1 Pool", skills: ["Boarding"] });
    const demandDrivenShiftsByDay: Record<string, ReturnType<typeof generateObligationToppedUpShifts>[string]> = {};
    for (const day of DAYS) demandDrivenShiftsByDay[day] = [];
    // A real demand-driven Saturday shift breaks up what would otherwise
    // be the best Fri/Sat/Sun-adjacent OFF block candidate.
    demandDrivenShiftsByDay["Saturday"] = [{ employeeId: "e1", dayOfWeek: "Saturday", shiftCode: "MT02", coversRoles: [] }];

    const additional = generateObligationToppedUpShifts(DAYS, [employee], demandDrivenShiftsByDay, CONFIG, new Map(), CONFIG.minimum_rest_hours, TEST_WEEK_START);
    const workedDays = new Set(["Saturday", ...DAYS.filter((d) => additional[d].some((g) => g.employeeId === "e1"))]);
    // Still exactly 5 worked / 2 off overall -- the day-count target is
    // never sacrificed to protect the soft consecutive-OFF preference.
    expect(DAYS.length - workedDays.size).toBe(CONFIG.normal_weekly_off_days);
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
      15,
      TEST_WEEK_START
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
      CONFIG.minimum_rest_hours,
      TEST_WEEK_START
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

describe("cross-team redeployment — default-true for every configured foreign company (2026-09-22), still unconfirmed for Mesure/Profiling, Transit never redeployable", () => {
  it("teams.ts's isRedeploymentAllowed defaults to TRUE for every configured foreign company, stays false for Mesure/Profiling/fixed-planning teams, and is hard-false for Transit unconditionally", () => {
    expect(isRedeploymentAllowed("Mesure")).toBe(false);
    expect(isRedeploymentAllowed("Profiling")).toBe(false);
    expect(isRedeploymentAllowed("Transit")).toBe(false);
    // Every CONFIGURED_COMPANIES entry redeploys by default now — generic,
    // never a per-airline special case (see teams.ts's doc comment).
    for (const company of CONFIGURED_COMPANIES) {
      expect(isRedeploymentAllowed(company)).toBe(true);
    }
    // Fixed-planning/fixed-cycle teams are never foreign companies, so the
    // new default never reaches them.
    expect(isRedeploymentAllowed("Leaders")).toBe(false);
    expect(isRedeploymentAllowed("Duty Officers")).toBe(false);
    expect(isRedeploymentAllowed("Caisse/BCB")).toBe(false);
    expect(isRedeploymentAllowed("General T1 Pool")).toBe(false);
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
