import { describe, it, expect } from "vitest";
import { evaluateRosterObligation } from "../lib/planning/roster-obligation";
import { CONFIG } from "../lib/seed-data";

/**
 * lib/planning/roster-obligation.ts is the mirror image of
 * lib/planning/average-hours.ts: that module evaluates a confirmed
 * CEILING (42h average) an employee's real hours must never exceed; this
 * one evaluates a currently UNCONFIRMED FLOOR/TARGET
 * (working_hours_obligation_hours) that roster generation should
 * eventually schedule an employee to reach, independent of flight
 * demand. Neither module may be implemented against a guessed number —
 * these tests protect the "not_evaluable while unconfirmed" contract,
 * exactly like average-hours.ts's own not_evaluable state.
 */
describe("evaluateRosterObligation — not_evaluable until a real obligation is confirmed", () => {
  it("returns not_evaluable when working_hours_obligation_hours is null (the current, real state)", () => {
    expect(CONFIG.working_hours_obligation_hours).toBeNull();
    const result = evaluateRosterObligation(10, CONFIG);
    expect(result).toEqual({ status: "not_evaluable", reason: "obligation_unconfirmed" });
  });

  it("never silently substitutes the 42h ceiling as the obligation target", () => {
    const configWithCeilingOnly = { ...CONFIG, working_hours_obligation_hours: null };
    const result = evaluateRosterObligation(42, configWithCeilingOnly);
    expect(result.status).toBe("not_evaluable");
  });

  it("once a real obligation is configured, reports 'short' when scheduled hours fall below it", () => {
    const configuredForTest = { ...CONFIG, working_hours_obligation_hours: 35 };
    const result = evaluateRosterObligation(20, configuredForTest);
    expect(result).toEqual({
      status: "short",
      scheduledHours: 20,
      obligationHours: 35,
      shortfallHours: 15,
    });
  });

  it("once a real obligation is configured, reports 'met' when scheduled hours reach or exceed it — never a negative shortfall", () => {
    const configuredForTest = { ...CONFIG, working_hours_obligation_hours: 35 };
    const exact = evaluateRosterObligation(35, configuredForTest);
    expect(exact).toEqual({ status: "met", scheduledHours: 35, obligationHours: 35, shortfallHours: 0 });

    const over = evaluateRosterObligation(40, configuredForTest);
    expect(over).toEqual({ status: "met", scheduledHours: 40, obligationHours: 35, shortfallHours: 0 });
  });
});
