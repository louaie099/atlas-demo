import { describe, it, expect } from "vitest";
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
 * M1 verification — the PoC demo dataset. Every assertion here runs the
 * REAL planning/scoring engine against the real dataset and checks what it
 * actually produces; nothing is asserted from a hand-predicted outcome.
 * This is the dry-run evidence the PoC acceptance criteria call for, kept
 * as a permanent regression so a future change to the dataset OR the
 * engine that breaks one of the four demo scenarios fails a test instead
 * of being discovered live in front of management.
 *
 * 2026-10-21 (PoC acceptance criteria formalized — see the delivered PoC
 * report): headcount raised from 14 to 17 (Profiling: 1 -> 3, plus one
 * extra early-shift Gate-qualified body) so the
 * BASELINE plan now has ZERO uncovered StaffingRequirement rows (Gate,
 * Boarding, Profiling, Qatar Airways), satisfying acceptance criterion 1's
 * explicit "zero uncovered requirements" — this used to be a deliberate,
 * standing gap (AT502's Profiling requirement, uncovered 2 of 7 days no
 * matter what) used as the "honest failure" demonstration. That
 * demonstration (criterion 4) now lives entirely inside a LIVE disruption
 * (Scenario D, below) instead, never in the starting state.
 *
 * Scenario mapping:
 *   A — generate the week, see a valid, COMPLETE plan: zero over-assigned
 *       requirements, zero double-bookings, zero uncovered Gate/Boarding/
 *       Profiling/company_config requirements.
 *   B — delay AT503/Wednesday, see the real invalidated Gate assignment
 *       and real replacement candidates (recommended + flagged, with
 *       reasons) — the plan starts healthy; this is what INTRODUCES the
 *       gap.
 *   C — (the actual reassignment call) is a manual UI/API action, not
 *       re-tested here — /api/confirm-reassignment already has its own
 *       coverage; what THIS dataset must prove is that Scenario B's
 *       candidate list genuinely contains at least one eligible
 *       replacement for C to act on, which the test below confirms.
 *   D — a SEPARATE live disruption: delay AT502/Tuesday (whose Profiling
 *       requirement, on a healthy baseline day, is covered by the ONE
 *       Profiling-qualified person rostered that day) far enough that her
 *       shift no longer reaches the new window. No other Profiling-
 *       qualified employee is on roster that day (the other two are
 *       genuinely off), so the replacement search comes back with zero
 *       real candidates — a genuine, engine-computed "no eligible
 *       replacement" case, caused by a live disruption, never a
 *       pre-existing baseline shortfall.
 *
 * T1 Check-in ZONE coverage (a separate, pre-existing, cross-dataset,
 * explicitly-labeled "prototype/unconfirmed policy" metric — see
 * components/planning-summary-bar.tsx's own doc comment and
 * lib/demo-poc/employees.ts's module comment for the full explanation of
 * why this is NOT the same thing as "uncovered requirements") is left
 * unchanged and still shows a real shortfall below — reported, not
 * suppressed, and explicitly out of scope for this milestone.
 */

function buildBundle(planId: string) {
  return buildDraftPlanBundle({
    planId,
    weekStart: POC_DEMO_WEEK_START,
    weekLabel: POC_DEMO_WEEK_LABEL,
    revision: 1,
    flights: POC_DEMO_FLIGHTS,
    employees: POC_DEMO_EMPLOYEES,
    config: POC_DEMO_CONFIG,
    daysOrder: POC_DEMO_DAYS_WITH_DATA,
  });
}

describe("PoC demo dataset — composition", () => {
  it("has exactly 17 employees and 5 distinct flight programs", () => {
    expect(POC_DEMO_EMPLOYEES.length).toBe(17);
    expect(POC_DEMO_EMPLOYEE_COUNT).toBe(17);
    const distinctFlightNumbers = new Set(POC_DEMO_FLIGHTS.map((f) => f.flight_number));
    expect(distinctFlightNumbers.size).toBe(5);
  });

  it("includes exactly three Profiling-qualified employees and one foreign-committed group", () => {
    const profilingQualified = POC_DEMO_EMPLOYEES.filter((e) => e.skills.includes("Profiling"));
    expect(profilingQualified.length).toBe(3);
    const qatarAuthorized = POC_DEMO_EMPLOYEES.filter((e) => e.foreign_company_authorizations.includes("Qatar Airways"));
    expect(qatarAuthorized.length).toBe(3);
  });
});

describe("Scenario A — generated plan is valid and has COMPLETE (zero-gap) staffing coverage", () => {
  const bundle = buildBundle("plan-poc-demo-verify");
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

  it("criterion 1 — ZERO uncovered StaffingRequirement rows (Gate, Boarding, Profiling, Qatar Airways)", () => {
    expect(requirements.length).toBeGreaterThan(0);
    const uncovered = requirements.filter(
      (r) => !bundle.assignments.some((a) => a.staffing_requirement_id === r.id) || bundle.assignments.filter((a) => a.staffing_requirement_id === r.id).length < r.total_requirement
    );
    expect(uncovered).toEqual([]);

    // Specifically re-confirm Profiling (the role the previous 1-person
    // design deliberately left short): all 7 of AT502's weekly instances
    // are now genuinely covered.
    const profilingReqs = requirements.filter((r) => r.role === "Profiling");
    expect(profilingReqs.length).toBe(7); // AT502 runs daily
    const coveredDays = profilingReqs.filter((r) => bundle.assignments.some((a) => a.staffing_requirement_id === r.id));
    expect(coveredDays.length).toBe(7);
  });

  it("has at least one genuine T1 Check-in ZONE coverage gap (a separate, pre-existing, cross-dataset, out-of-scope metric — see this dataset's own module comment)", () => {
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

describe("Scenario D — a LIVE delay to AT502/Tuesday genuinely leaves the Profiling requirement with zero eligible replacements", () => {
  it("invalidates the sole Profiling incumbent rostered that day, with no other Profiling-qualified employee on roster to replace her", () => {
    const requirements = computeWeeklyStaffingRequirements(POC_DEMO_FLIGHTS, POC_DEMO_CONFIG);
    const bundle = buildBundle("plan-poc-demo-verify-d");

    const at502Tue = POC_DEMO_FLIGHTS.find((f) => f.flight_number === "AT502" && f.day_of_week === "Tuesday")!;
    expect(at502Tue.scheduled_departure).toBe("11:30");

    const profilingReq = requirements.find((r) => r.flight_id === at502Tue.id && r.role === "Profiling")!;
    const originalWindow = getRequirementWindow(profilingReq, at502Tue);
    expect(originalWindow).toEqual({ start: "10:30", end: "11:30" });

    const pool = buildDayEffectivePoolFromRosterEntries(POC_DEMO_EMPLOYEES, bundle.rosterEntries, "Tuesday", at502Tue.flight_date);
    const profilingOnRosterBefore = pool.filter((e) => e.skills.includes("Profiling"));
    // The baseline plan is healthy going in: exactly one Profiling-
    // qualified person is rostered Tuesday, and her real shift already
    // covers the original window (this is a live disruption, not a
    // pre-existing bug).
    expect(profilingOnRosterBefore).toHaveLength(1);
    const incumbent = profilingOnRosterBefore[0];
    expect(isWindowWithinShift(originalWindow, incumbent.shift_start, incumbent.shift_end)).toBe(true);
    const incumbentId = bundle.assignments.find((a) => a.staffing_requirement_id === profilingReq.id)?.employee_id;
    expect(incumbentId).toBe(incumbent.id);

    // The live delay: AT502/Tuesday 11:30 -> 15:30 (4h). New window:
    // 14:30-15:30 (standard-aircraft 60-minute lead) — past the
    // incumbent's own real shift end.
    const delayedFlight = { ...at502Tue, scheduled_departure: "15:30" };
    const delayedWindow = getRequirementWindow(profilingReq, delayedFlight);
    expect(delayedWindow).toEqual({ start: "14:30", end: "15:30" });
    expect(isWindowWithinShift(delayedWindow, incumbent.shift_start, incumbent.shift_end)).toBe(false);

    // Real replacement search for the now-vacant Profiling slot, excluding
    // whoever already (invalidly) holds it — the SAME engine Find Agent
    // uses, never a separate or looser rule.
    const occupied = computeBusyWindowsForDay("Tuesday", bundle.assignments, requirements, POC_DEMO_FLIGHTS, pool);
    const notYetAssigned = pool.filter((e) => e.id !== incumbent.id);
    const candidates = scoreCandidates("Profiling", delayedWindow, notYetAssigned, POC_DEMO_CONFIG, occupied);

    // The genuinely unresolvable case: no OTHER Profiling-qualified
    // employee is even on roster Tuesday (the other two are genuinely
    // off that day) — zero real candidates, honestly reported, never
    // fabricated.
    expect(candidates.length).toBe(0);
    expect(pool.filter((e) => e.skills.includes("Profiling") && e.id !== incumbent.id)).toHaveLength(0);
  });
});

describe("Scenario B/C — a live delay to AT503/Wednesday genuinely invalidates one assignment and offers real replacements", () => {
  it("invalidates the real Gate incumbent's assignment and leaves Boarding untouched, with real recommended + flagged replacement candidates", () => {
    const requirements = computeWeeklyStaffingRequirements(POC_DEMO_FLIGHTS, POC_DEMO_CONFIG);
    const bundle = buildBundle("plan-poc-demo-verify-bc");

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
