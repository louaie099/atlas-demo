import { describe, it, expect } from "vitest";
import {
  buildGlobalOffDayCap,
  globalOffDayCapAllowsStart,
  recordPlacedOffWindow,
  planDemandAwareOffWindows,
} from "../lib/planning/off-window";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

describe("GlobalOffDayCap (2026-10-20, cross-population OFF-day spread)", () => {
  it("buildGlobalOffDayCap derives a flat per-day ceiling from total entitlement / day count, plus slack", () => {
    // 49 employees * 2 OFF days / 7 days = 14 even share -> ceil(14) + default slack(2) = 16.
    const cap = buildGlobalOffDayCap(7, 49, 2);
    expect(cap.cap).toEqual(Array(7).fill(16));
    expect(cap.countSoFar).toEqual(Array(7).fill(0));

    // A non-exact division still rounds up before adding slack: 47*2/7 = 13.43 -> 14 + 2 = 16.
    const cap2 = buildGlobalOffDayCap(7, 47, 2);
    expect(cap2.cap).toEqual(Array(7).fill(16));

    // Slack is a caller-tunable parameter, not hardcoded.
    const cap3 = buildGlobalOffDayCap(7, 47, 2, 0);
    expect(cap3.cap).toEqual(Array(7).fill(14));
  });

  it("globalOffDayCapAllowsStart permits a window until it would push any of its days over the cap, then rejects it", () => {
    const cap = buildGlobalOffDayCap(7, 7, 2, 0); // perDayCap = ceil(14/7) = 2, no slack
    // Monday = index 0. Fill Monday to its cap (2) via two single-day windows.
    recordPlacedOffWindow(DAYS, cap, new Set(["Mon"]));
    recordPlacedOffWindow(DAYS, cap, new Set(["Mon"]));
    expect(cap.countSoFar[0]).toBe(2);
    // A third single-day Monday window would push it to 3 > cap 2 -> rejected.
    expect(globalOffDayCapAllowsStart(DAYS, cap, 0, 1)).toBe(false);
    // Tuesday (index 1) is still untouched -> allowed.
    expect(globalOffDayCapAllowsStart(DAYS, cap, 1, 1)).toBe(true);
    // A 2-day window starting Sunday (wraps to Monday) is rejected because its second day (Monday) is full.
    expect(globalOffDayCapAllowsStart(DAYS, cap, 6, 2)).toBe(false);
  });

  it("globalOffDayCapAllowsStart is a no-op (always allows) when no cap is supplied", () => {
    expect(globalOffDayCapAllowsStart(DAYS, undefined, 0, 2)).toBe(true);
  });

  it("two independent populations sharing one GlobalOffDayCap do not both pile their OFF windows onto the same lowest-demand day", () => {
    // Both populations see Monday/Tuesday as the clear lowest-demand window
    // (requiredByDay below is intentionally identical and heavily favors
    // day 0-1).
    const requiredByDay = [0, 0, 5, 5, 5, 5, 5]; // Mon/Tue look empty, rest looks busy
    const popA = ["a1", "a2", "a3", "a4"];
    const popB = ["b1", "b2", "b3", "b4"];

    // COUNTERFACTUAL: with NO shared cap (today's pre-fix behavior for two
    // generators answering the same calendar independently), both
    // populations' own water-filling converges on the exact same two days
    // regardless of what the other population already placed there.
    const planAUnshared = planDemandAwareOffWindows({ daysOrder: DAYS, employeeIds: popA, requiredByDay, offDaysTarget: 2, capacity: popA.length });
    const planBUnshared = planDemandAwareOffWindows({ daysOrder: DAYS, employeeIds: popB, requiredByDay, offDaysTarget: 2, capacity: popB.length });
    const unsharedTotal = DAYS.map(() => 0);
    for (const plan of [planAUnshared, planBUnshared])
      for (const window of plan.windows.values()) for (let i = 0; i < DAYS.length; i++) if (window.has(DAYS[i])) unsharedTotal[i]++;
    expect(Math.max(...unsharedTotal)).toBe(8); // every single person from both populations lands on the same day

    // WITH the shared cap: a per-day ceiling of 3 (8 people * 2 off-days /
    // 7 days, rounded up, no slack).
    const cap = buildGlobalOffDayCap(7, 8, 2, 0);
    const planA = planDemandAwareOffWindows({
      daysOrder: DAYS,
      employeeIds: popA,
      requiredByDay,
      offDaysTarget: 2,
      capacity: popA.length,
      isAllowedStart: (id, start) => globalOffDayCapAllowsStart(DAYS, cap, start, 2),
      refineDeficit: true,
    });
    for (const w of planA.windows.values()) recordPlacedOffWindow(DAYS, cap, w);

    const planB = planDemandAwareOffWindows({
      daysOrder: DAYS,
      employeeIds: popB,
      requiredByDay,
      offDaysTarget: 2,
      capacity: popB.length,
      isAllowedStart: (id, start) => globalOffDayCapAllowsStart(DAYS, cap, start, 2),
      refineDeficit: true,
    });
    for (const w of planB.windows.values()) recordPlacedOffWindow(DAYS, cap, w);

    const totalOffPerDay = DAYS.map(() => 0);
    for (const plan of [planA, planB]) {
      for (const window of plan.windows.values()) {
        for (let i = 0; i < DAYS.length; i++) if (window.has(DAYS[i])) totalOffPerDay[i]++;
      }
    }
    // Every day stays at or just over the cap -- "just over" because the
    // guard is a soft, narrowing filter like every other isAllowedStart
    // guard in this module: if it would exclude literally every candidate
    // start for one employee, the existing "never leave someone without a
    // preference" fallback (shared with priorDayOffEmployeeIds etc.) takes
    // priority, which can rarely push one day one person over the cap in a
    // pathological squeeze. The real claim is the dramatic reduction below,
    // not an absolute guarantee.
    for (const count of totalOffPerDay) expect(count).toBeLessThanOrEqual(cap.cap[0] + 1);
    expect(Math.max(...totalOffPerDay)).toBeLessThan(8); // nowhere near the unshared 8-on-one-day pileup

    const totalPeople = popA.length + popB.length;
    const totalOffDays = totalOffPerDay.reduce((s, c) => s + c, 0);
    expect(totalOffDays).toBe(totalPeople * 2); // nobody lost an OFF day entitlement to the cap
  });

  it("the cap never leaves an employee with zero OFF days even when every window would exceed it (fallback to unrestricted best)", () => {
    // An impossibly tight cap (0 everywhere) must still fall back to SOME
    // window per employee -- this is a scheduling heuristic to spread
    // load, never allowed to be the reason someone loses their legal OFF
    // entitlement (see off-window.ts's own "never leave someone without a
    // preference" fallback, which this mechanism must not break).
    const cap = buildGlobalOffDayCap(7, 1, 2, -2); // perDayCap = ceil(2/7)+(-2) = 1-2 = -1 (impossible everywhere)
    const plan = planDemandAwareOffWindows({
      daysOrder: DAYS,
      employeeIds: ["solo"],
      requiredByDay: [0, 0, 0, 0, 0, 0, 0],
      offDaysTarget: 2,
      isAllowedStart: (id, start) => globalOffDayCapAllowsStart(DAYS, cap, start, 2),
    });
    expect(plan.windows.get("solo")?.size).toBe(2);
  });
});
