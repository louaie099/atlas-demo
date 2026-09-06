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
});
