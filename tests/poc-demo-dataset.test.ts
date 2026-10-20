import { describe, it, expect } from "vitest";
import { generateDraftWeeklyPlan } from "../lib/planning/generate-draft-plan";
import { buildDraftPlanBundle } from "../lib/planning/weekly-plan-service";
import { computeWeeklyStaffingRequirements } from "../lib/planning/weekly-requirements";
import { buildPersistedWeeklyPlanView } from "../lib/planning/persisted-plan-view";
import { scoreCandidates, isWindowWithinShift } from "../lib/scoring";
import { buildDayEffectivePoolFromRosterEntries, computeBusyWindowsForDay } from "../lib/planning/duty-generation";
import { getRequirementWindow } from "../lib/planning/requirement-window";
import {
  POC_DEMO_CONFIG,
  POC_DEMO_EMPLOYEES,
  POC_DEMO_FLIGHTS,
  POC_DEMO_DAYS_WITH_DATA,
  POC_DEMO_WEEK_START,
  POC_DEMO_WEEK_LABEL,
} from "../lib/demo-poc/dataset";
import { POC_DEMO_EMPLOYEE_COUNT } from "../lib/demo-poc/employees";

/**
 * M1 verification — the PoC demo dataset (docs/ATLAS_POC_PLAN.md Section
 * 5). Every assertion here runs the REAL planning/scoring engine against
 * the real dataset and checks what it actually produces; nothing is
 * asserted from a hand-predicted outcome. This is the dry-run evidence
 * the approved plan calls for, kept as a permanent regression so a future
 * change to the dataset OR the engine that breaks one of the four demo
 * scenarios fails a test instead of being discovered live in front of
 * management.
 *
 * Scenario mapping (docs/ATLAS_POC_PLAN.md Section 6):
 *   A — generate the week, see a valid plan with a genuine, identified gap.
 *   B — delay AT503/Wednesday, see the real invalidated assignment and
 *       real replacement candidates (recommended + flagged, with reasons).
 *   C — (the actual reassignment call) is a manual UI/API action, not
 *       re-tested here — /api/confirm-reassignment already has its own
 *       coverage; what THIS dataset must prove is that Scenario B's
 *       candidate list genuinely contains at least one eligible
 *       replacement for C to act on, which the test below confirms.
 *   D — AT502's Profiling requirement on a day the single Profiling-
 *       qualified employee is off-roster: genuinely zero candidates.
 */

describe("PoC demo dataset — composition", () => {
  it("has exactly 14 employees and 5 distinct flight programs", () => {
    expect(POC_DEMO_EMPLOYEES.length).toBe(14);
    expect(POC_DEMO_EMPLOYEE_COUNT).toBe(14);
    const distinctFlightNumbers = new Set(POC_DEMO_FLIGHTS.map((f) => f.flight_number));
    expect(distinctFlightNumbers.size).toBe(5);
  });

  it("includes exactly one Profiling-qualified employee and one foreign-committed group", () => {
    const profilingQualified = POC_DEMO_EMPLOYEES.filter((e) => e.skills.includes("Profiling"));
    expect(profilingQualified.length).toBe(1);
    const qatarAuthorized = POC_DEMO_EMPLOYEES.filter((e) => e.foreign_company_authorizations.includes("Qatar Airways"));
    expect(qatarAuthorized.length).toBe(3);
  });
});

describe("Scenario A — generated plan is valid and has a genuine, identified gap", () => {
  const bundle = buildDraftPlanBundle({
    planId: "plan-poc-demo-verify",
    weekStart: POC_DEMO_WEEK_START,
    weekLabel: POC_DEMO_WEEK_LABEL,
    revision: 1,
    flights: POC_DEMO_FLIGHTS,
    employees: POC_DEMO_EMPLOYEES,
    config: POC_DEMO_CONFIG,
    daysOrder: POC_DEMO_DAYS_WITH_DATA,
  });
  const requirements = computeWeeklyStaffingRequirements(POC_DEMO_FLIGHTS, POC_DEMO_CONFIG);

  it("never persists a discrete automatic zone assignment row (same invariant as the main/small datasets)", () => {
    expect(bundle.zoneRequirements.length).toBeGreaterThan(0);
    expect(bundle.zoneAssignments.length).toBe(0);
  });

  it("produces zero headcount violations: no requirement over-assigned, no employee double-booked", () => {
    const byRequirement = new Map<string, number>();
    for (const a of bundle.assignments) {
      byRequirement.set(a.staffing_requirement_id, (byRequirement.get(a.staffing_requirement_id) ?? 0) + 1);
    }
    for (const req of requirements) {
      const assignedCount = byRequirement.get(req.id) ?? 0;
      expect(assignedCount).toBeLessThanOrEqual(req.total_requirement);
    }
    const seenPerEmployeePerRequirement = new Set<string>();
    for (const a of bundle.assignments) {
      const key = `${a.employee_id}::${a.staffing_requirement_id}`;
      expect(seenPerEmployeePerRequirement.has(key)).toBe(false);
      seenPerEmployeePerRequirement.add(key);
    }
  });

  it("has a genuine, non-zero Profiling shortfall across the week (the gap Scenario A/D shares)", () => {
    const profilingReqs = requirements.filter((r) => r.role === "Profiling");
    expect(profilingReqs.length).toBe(7); // AT502 runs daily
    const coveredDays = profilingReqs.filter((r) => bundle.assignments.some((a) => a.staffing_requirement_id === r.id));
    const uncoveredDays = profilingReqs.filter((r) => !bundle.assignments.some((a) => a.staffing_requirement_id === r.id));
    // Headcount-forced: 1 Profiling-qualified employee can cover at most
    // 5 of 7 days (2 OFF days/week, the same confirmed rule every
    // employee follows) — so at least 2 days MUST be short, regardless of
    // which 2 the engine's own OFF-day optimizer picks.
    expect(uncoveredDays.length).toBeGreaterThanOrEqual(2);
    expect(coveredDays.length).toBeGreaterThanOrEqual(5);
  });

  it("has at least one genuine T1 Check-in zone coverage gap", () => {
    const view = buildPersistedWeeklyPlanView(
      bundle.plan,
      bundle.rosterEntries,
      bundle.assignments,
      requirements,
      POC_DEMO_FLIGHTS,
      POC_DEMO_EMPLOYEES,
      POC_DEMO_DAYS_WITH_DATA,
      bundle.zoneRequirements,
      bundle.zoneAssignments
    );
    const gaps = view.zoneCoverage.filter((zc) => zc.gap > 0);
    expect(gaps.length).toBeGreaterThan(0);
    // Sane bound, same invariant the main/small datasets' own zone tests
    // check — never more available than the whole active headcount.
    const totalActive = POC_DEMO_EMPLOYEES.filter((e) => e.active).length;
    for (const zc of view.zoneCoverage) {
      expect(zc.available).toBeLessThanOrEqual(totalActive);
      expect(zc.available).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("Scenario D — AT502's Profiling requirement is genuinely unresolvable on an uncovered day", () => {
  it("finds a day with zero real candidates for AT502's Profiling requirement", () => {
    const draft = generateDraftWeeklyPlan(
      POC_DEMO_FLIGHTS,
      POC_DEMO_EMPLOYEES,
      [],
      POC_DEMO_CONFIG,
      POC_DEMO_DAYS_WITH_DATA,
      POC_DEMO_WEEK_LABEL,
      POC_DEMO_WEEK_START
    );
    const requirements = computeWeeklyStaffingRequirements(POC_DEMO_FLIGHTS, POC_DEMO_CONFIG);
    const bundle = buildDraftPlanBundle({
      planId: "plan-poc-demo-verify-d",
      weekStart: POC_DEMO_WEEK_START,
      weekLabel: POC_DEMO_WEEK_LABEL,
      revision: 1,
      flights: POC_DEMO_FLIGHTS,
      employees: POC_DEMO_EMPLOYEES,
      config: POC_DEMO_CONFIG,
      daysOrder: POC_DEMO_DAYS_WITH_DATA,
    });

    const profilingReqs = requirements.filter((r) => r.role === "Profiling");
    const uncoveredDayReq = profilingReqs.find(
      (r) => !bundle.assignments.some((a) => a.staffing_requirement_id === r.id)
    );
    expect(uncoveredDayReq).toBeDefined();

    const flight = POC_DEMO_FLIGHTS.find((f) => f.id === uncoveredDayReq!.flight_id)!;
    const window = getRequirementWindow(uncoveredDayReq!, flight);
    const pool = buildDayEffectivePoolFromRosterEntries(POC_DEMO_EMPLOYEES, bundle.rosterEntries, flight.day_of_week, flight.flight_date);
    const occupied = computeBusyWindowsForDay(flight.day_of_week, bundle.assignments, requirements, POC_DEMO_FLIGHTS, pool);
    const candidates = scoreCandidates("Profiling", window, pool, POC_DEMO_CONFIG, occupied);

    // The genuinely unresolvable case: nobody qualified is even on roster
    // that day — the one Profiling-qualified employee is off.
    expect(candidates.length).toBe(0);
    expect(pool.some((e) => e.skills.includes("Profiling"))).toBe(false);

    // Sanity: a DIFFERENT day's Profiling requirement (one the engine DID
    // cover) genuinely has the qualified employee on roster — proving the
    // zero-candidate day above is a real headcount gap, not a dataset-wide
    // bug that would make every day show zero.
    const coveredDayReq = profilingReqs.find((r) => bundle.assignments.some((a) => a.staffing_requirement_id === r.id));
    expect(coveredDayReq).toBeDefined();
    const coveredFlight = POC_DEMO_FLIGHTS.find((f) => f.id === coveredDayReq!.flight_id)!;
    const coveredPool = buildDayEffectivePoolFromRosterEntries(
      POC_DEMO_EMPLOYEES,
      bundle.rosterEntries,
      coveredFlight.day_of_week,
      coveredFlight.flight_date
    );
    expect(coveredPool.some((e) => e.skills.includes("Profiling"))).toBe(true);
  });
});

describe("Scenario B/C — a live delay to AT503/Wednesday genuinely invalidates one assignment and offers real replacements", () => {
  it("invalidates the real Gate incumbent's assignment and leaves Boarding untouched, with real recommended + flagged replacement candidates", () => {
    const requirements = computeWeeklyStaffingRequirements(POC_DEMO_FLIGHTS, POC_DEMO_CONFIG);
    const bundle = buildDraftPlanBundle({
      planId: "plan-poc-demo-verify-bc",
      weekStart: POC_DEMO_WEEK_START,
      weekLabel: POC_DEMO_WEEK_LABEL,
      revision: 1,
      flights: POC_DEMO_FLIGHTS,
      employees: POC_DEMO_EMPLOYEES,
      config: POC_DEMO_CONFIG,
      daysOrder: POC_DEMO_DAYS_WITH_DATA,
    });

    const at503Wed = POC_DEMO_FLIGHTS.find((f) => f.flight_number === "AT503" && f.day_of_week === "Wednesday")!;
    expect(at503Wed.scheduled_departure).toBe("14:00");

    const gateReq = requirements.find((r) => r.flight_id === at503Wed.id && r.role === "Gate")!;
    const boardingReq = requirements.find((r) => r.flight_id === at503Wed.id && r.role === "Boarding")!;
    const originalWindow = getRequirementWindow(gateReq, at503Wed);
    expect(originalWindow).toEqual({ start: "13:00", end: "14:00" });

    const pool = buildDayEffectivePoolFromRosterEntries(POC_DEMO_EMPLOYEES, bundle.rosterEntries, "Wednesday", at503Wed.flight_date);

    const gateIncumbentId = bundle.assignments.find((a) => a.staffing_requirement_id === gateReq.id)?.employee_id;
    const boardingIncumbentId = bundle.assignments.find((a) => a.staffing_requirement_id === boardingReq.id)?.employee_id;
    expect(gateIncumbentId).toBeDefined();
    expect(boardingIncumbentId).toBeDefined();
    const gateIncumbent = pool.find((e) => e.id === gateIncumbentId)!;
    const boardingIncumbent = pool.find((e) => e.id === boardingIncumbentId)!;

    // Confirm both incumbents' real shifts fully cover the ORIGINAL window
    // — i.e. this plan was valid before the delay (not a pre-existing bug).
    expect(isWindowWithinShift(originalWindow, gateIncumbent.shift_start, gateIncumbent.shift_end)).toBe(true);
    expect(isWindowWithinShift(originalWindow, boardingIncumbent.shift_start, boardingIncumbent.shift_end)).toBe(true);

    // The live delay: AT503/Wednesday 14:00 -> 15:45 (1h45). New window:
    // 14:45-15:45 (standard-aircraft 60-minute lead).
    const delayedFlight = { ...at503Wed, scheduled_departure: "15:45" };
    const delayedWindow = getRequirementWindow(gateReq, delayedFlight);
    expect(delayedWindow).toEqual({ start: "14:45", end: "15:45" });

    // The Gate incumbent's real shift no longer fully contains the new
    // window — a genuine, engine-detected conflict.
    expect(isWindowWithinShift(delayedWindow, gateIncumbent.shift_start, gateIncumbent.shift_end)).toBe(false);
    // The Boarding incumbent's real shift still does — this delay amount
    // was chosen so exactly ONE of the two assignments is affected.
    expect(isWindowWithinShift(delayedWindow, boardingIncumbent.shift_start, boardingIncumbent.shift_end)).toBe(true);

    // Real replacement candidates for the now-vacant Gate slot, excluding
    // whoever already holds it.
    const occupied = computeBusyWindowsForDay("Wednesday", bundle.assignments, requirements, POC_DEMO_FLIGHTS, pool);
    const notYetAssignedGate = pool.filter((e) => e.id !== gateIncumbentId);
    const candidates = scoreCandidates("Gate", delayedWindow, notYetAssignedGate, POC_DEMO_CONFIG, occupied);

    const recommended = candidates.filter((c) => c.status === "recommended");
    const flagged = candidates.filter((c) => c.status === "flagged");
    // At least one real, immediately-assignable replacement — Scenario C
    // needs this to exist to demonstrate a human confirming a reassignment.
    expect(recommended.length).toBeGreaterThanOrEqual(1);
    // At least one real candidate the system honestly flags rather than
    // silently offering, with a genuine, non-empty stated reason —
    // Scenario B's "explain why, without auto-deciding."
    expect(flagged.length).toBeGreaterThanOrEqual(1);
    for (const f of flagged) {
      expect(f.reasoning.length).toBeGreaterThan(0);
    }
  });
});