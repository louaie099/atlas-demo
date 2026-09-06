import { describe, it, expect } from "vitest";
import { deriveTeamRotation, DemandDay, RotationInfeasibleError } from "../lib/rotation-feasibility";

const ALL_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function demand(flightDays: string[], requiredAgents: number): DemandDay[] {
  return ALL_DAYS.map((d) => ({ dayOfWeek: d, requiredAgents: flightDays.includes(d) ? requiredAgents : 0 }));
}

describe("deriveTeamRotation — hard feasibility vs. ranking", () => {
  it("never rejects a candidate for fragmented (non-contiguous) OFF days alone", () => {
    // Gulf Air real demo shape: Mon/Wed/Fri/Sun, needs 2, headcount 6.
    // A single undivided group can only rest on Tue+Thu — a genuinely
    // fragmented (non-contiguous) OFF-day set — which must still be a
    // valid, HARD-feasible candidate (continuity is ranking only).
    const result = deriveTeamRotation(6, demand(["Monday", "Wednesday", "Friday", "Sunday"], 2), ALL_DAYS, 2, undefined, 1);
    expect(result.feasible).toBe(true);
    expect(result.candidate?.groupCount).toBe(1);
    expect(result.candidate?.groups[0].offDays.sort()).toEqual(["Thursday", "Tuesday"]);
    expect(result.candidate?.groups[0].restContinuityScore).toBe(0);
  });

  it("prefers a higher-continuity candidate across group counts over a fragmented lower-group-count one", () => {
    const result = deriveTeamRotation(6, demand(["Monday", "Wednesday", "Friday", "Sunday"], 2), ALL_DAYS, 2);
    expect(result.feasible).toBe(true);
    // The 2-group split with fully contiguous rest per group outranks the
    // fragmented 1-group candidate, even though 1 group is "simpler".
    expect(result.candidate?.groupCount).toBe(2);
    expect(result.candidate?.qualityScore).toBe(1);
    for (const g of result.candidate!.groups) expect(g.restContinuityScore).toBe(1);
  });

  it("reports a genuine capacity gap as infeasible, never as a degraded roster", () => {
    // 2 agents can never cover a 3-agent daily requirement, at any group
    // count or OFF-day placement.
    const result = deriveTeamRotation(2, demand(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"], 3), ALL_DAYS, 2);
    expect(result.feasible).toBe(false);
    expect(result.candidate).toBeUndefined();
    expect(result.reason).toBeTruthy();
  });
});

describe("deriveTeamRotation — maxConsecutiveOffDays as a HARD labor-protection gate", () => {
  it("rejects a candidate whose OFF-day placement would exceed the resolved max-consecutive-OFF protection, even though it satisfies OFF-day count and demand coverage", () => {
    // With a single group (groupCount capped to 1) and Gulf Air's
    // Mon/Wed/Fri/Sun demand shape, the only 2-OFF-day set that clears
    // demand is Tue+Thu — already contiguity-free, well within 2
    // consecutive. To exercise the hard cap itself, use a demand shape
    // whose only 2-OFF-day-count feasible placement is 2 CONSECUTIVE OFF
    // days landing back-to-back with a 3rd (via a maxConsecutiveOffDays=1
    // cap that must reject it) — asserting the filter fires at all is the
    // point, not the exact placement.
    const noDemand = demand([], 0); // every day is free — every 2-day combo clears coverage
    const strict = deriveTeamRotation(7, noDemand, ALL_DAYS, 2, undefined, 1, 1);
    // maxConsecutiveOffDays=1 forbids ANY 2-day OFF combination for a
    // single undivided group, since any 2 OFF days chosen from a 7-day
    // week either land adjacent (2 consecutive, exceeding 1) or, if not
    // adjacent, still leaves the group workable — but a single group of
    // 7 must place both OFF days somewhere; with only 1 group allowed
    // (maxGroupCount=1) every combination of 2 distinct days is tested,
    // and only the non-adjacent ones survive a maxConsecutiveOffDays=1 gate.
    expect(strict.feasible).toBe(true); // non-adjacent 2-OFF-day placements still exist and survive
    if (strict.candidate) {
      const offDays = strict.candidate.groups[0].offDays;
      const indices = offDays.map((d) => ALL_DAYS.indexOf(d)).sort((a, b) => a - b);
      // Never two cyclically-adjacent OFF days when maxConsecutiveOffDays=1.
      const adjacent = indices.some((idx, i) => {
        const next = indices[(i + 1) % indices.length];
        return (next - idx + ALL_DAYS.length) % ALL_DAYS.length === 1 && indices.length > 1;
      });
      expect(adjacent).toBe(false);
    }
  });

  it("reports genuine infeasibility when NO candidate can satisfy both demand coverage and the max-consecutive-OFF protection", () => {
    // Every day is required (headcount must work every day), so a single
    // group can never take 2 OFF days at all without a coverage
    // shortfall on some day — genuinely infeasible regardless of the
    // consecutive-OFF cap, proving the gate never manufactures a fake
    // pass.
    const fullDemand = demand(ALL_DAYS, 5);
    const result = deriveTeamRotation(5, fullDemand, ALL_DAYS, 2, undefined, 1, 2);
    expect(result.feasible).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("omitting maxConsecutiveOffDays entirely preserves old behavior (no consecutive-OFF gate applied)", () => {
    const result = deriveTeamRotation(6, demand(["Monday", "Wednesday", "Friday", "Sunday"], 2), ALL_DAYS, 2, undefined, 1);
    expect(result.feasible).toBe(true);
  });
});

describe("RotationInfeasibleError", () => {
  it("carries the full detail needed to resolve a capacity gap", () => {
    const gapDemand = demand(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"], 3);
    const err = new RotationInfeasibleError("Test Airline", 2, gapDemand, "No rotation covers demand.");
    expect(err.team).toBe("Test Airline");
    expect(err.headcount).toBe(2);
    expect(err.message).toContain("team_rotation_infeasible");
    expect(err.message).toContain("Test Airline");
    expect(err.message).toContain("2 assigned agent");
  });

  it("names the resolved OFF-day count dynamically when given, instead of a hardcoded '2-OFF-days rule' string", () => {
    const gapDemand = demand(["Monday"], 3);
    const err3 = new RotationInfeasibleError("Test Airline", 2, gapDemand, "No rotation covers demand.", 3);
    expect(err3.message).toContain("3-OFF-days labor protection");
    expect(err3.message).not.toContain("2-OFF-days");

    const errNoCount = new RotationInfeasibleError("Test Airline", 2, gapDemand, "No rotation covers demand.");
    expect(errNoCount.message).toContain("confirmed labor protections");
  });
});
