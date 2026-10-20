import { describe, it, expect } from "vitest";
import { scheduledSpanHours, computePaidHours } from "../lib/planning/paid-hours";
import { DEFAULT_BREAK_POLICY, BreakPolicy } from "../lib/break-policy";

// Post-regime (>= 2026-09-20) shift codes used throughout this suite:
// MT03 = 05:45-14:45 (9h), AP01 = 13:45-22:45 (9h).
const DATE = "2026-10-21"; // a Wednesday, post-regime

describe("lib/planning/paid-hours — scheduled span vs paid hours (Option C)", () => {
  it("scheduledSpanHours matches the shift catalog's raw duration, overnight-safe", () => {
    expect(scheduledSpanHours("MT03", DATE)).toBe(9);
  });

  it("with the default (disabled) break policy, paid hours equals scheduled span exactly", () => {
    const result = computePaidHours("MT03", DATE);
    expect(result.scheduledSpanHours).toBe(9);
    expect(result.paidHours).toBe(9);
    expect(result.breakApplied).toBe(false);
    expect(result.provisional).toBe(true); // DEFAULT_BREAK_POLICY.source is unconfirmed_prototype
  });

  it("paid hours equals scheduled span when breakPolicy.enabled is explicitly false, regardless of a deduction value being present", () => {
    const policy: BreakPolicy = { enabled: false, source: "confirmed_management_policy", unpaidBreakMinutesPerShift: 30, minimumShiftHoursForBreak: null };
    const result = computePaidHours("MT03", DATE, policy);
    expect(result.paidHours).toBe(9);
    expect(result.breakApplied).toBe(false);
    expect(result.provisional).toBe(false); // confirmed source => not provisional
  });

  it("deducts the configured break when enabled and no minimum-shift-length threshold is set", () => {
    const policy: BreakPolicy = { enabled: true, source: "confirmed_management_policy", unpaidBreakMinutesPerShift: 30, minimumShiftHoursForBreak: null };
    const result = computePaidHours("MT03", DATE, policy); // 9h span
    expect(result.scheduledSpanHours).toBe(9);
    expect(result.paidHours).toBe(8.5);
    expect(result.breakApplied).toBe(true);
  });

  it("does not deduct when the shift is shorter than minimumShiftHoursForBreak", () => {
    const policy: BreakPolicy = { enabled: true, source: "confirmed_management_policy", unpaidBreakMinutesPerShift: 30, minimumShiftHoursForBreak: 10 };
    const result = computePaidHours("MT03", DATE, policy); // 9h span < 10h threshold
    expect(result.paidHours).toBe(9);
    expect(result.breakApplied).toBe(false);
  });

  it("does deduct when the shift meets the minimum-shift-length threshold", () => {
    const policy: BreakPolicy = { enabled: true, source: "confirmed_management_policy", unpaidBreakMinutesPerShift: 45, minimumShiftHoursForBreak: 8 };
    const result = computePaidHours("AP01", DATE, policy); // 9h span >= 8h threshold
    expect(result.paidHours).toBe(8.25);
    expect(result.breakApplied).toBe(true);
  });

  it("never returns negative paid hours even with an absurd deduction", () => {
    const policy: BreakPolicy = { enabled: true, source: "confirmed_management_policy", unpaidBreakMinutesPerShift: 999, minimumShiftHoursForBreak: null };
    const result = computePaidHours("MT03", DATE, policy);
    expect(result.paidHours).toBe(0);
  });
});
