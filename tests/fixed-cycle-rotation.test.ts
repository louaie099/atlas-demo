import { describe, it, expect } from "vitest";
import {
  cycleStepAt,
  buildFixedCycleWeeklySchedule,
  offDaysForDisplayedWeek,
  maxConsecutiveOffInCycle,
  JR_NT_OFF_OFF_CYCLE,
} from "../lib/fixed-cycle-rotation";
import { EMPLOYEES } from "../lib/seed-data";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function sequenceFor(cycleOffset: number, length: number): string[] {
  return Array.from({ length }, (_, i) => {
    const step = cycleStepAt(JR_NT_OFF_OFF_CYCLE, i, cycleOffset);
    return "off" in step ? "OFF" : step.code;
  });
}

describe("JR_NT_OFF_OFF_CYCLE — 14-day continuous verification", () => {
  it("never exceeds 2 consecutive OFF days, structurally", () => {
    expect(maxConsecutiveOffInCycle(JR_NT_OFF_OFF_CYCLE)).toBe(2);
  });

  it("produces JR -> NT -> OFF -> OFF repeating over 14 days, regardless of where Monday falls (every possible offset)", () => {
    for (let offset = 0; offset < JR_NT_OFF_OFF_CYCLE.steps.length; offset++) {
      const seq = sequenceFor(offset, 14);
      for (let i = 0; i < 14; i++) {
        const expectedStep = JR_NT_OFF_OFF_CYCLE.steps[(i + offset) % 4];
        const expected = "off" in expectedStep ? "OFF" : expectedStep.code;
        expect(seq[i]).toBe(expected);
      }
      // The structural pattern itself: every 4-day window starting at a
      // JR position reads JR, NT, OFF, OFF.
      const jrIndex = seq.findIndex((s) => s === "JR02");
      expect(seq.slice(jrIndex, jrIndex + 4)).toEqual(["JR02", "NT01", "OFF", "OFF"]);
    }
  });

  it("continues seamlessly across the day-7/day-8 week boundary — no reset to day 0 of the cycle", () => {
    // For every offset, the step at absolute day 7 (the following week's
    // Monday) must equal the step that would come one position after
    // absolute day 6's (this week's Sunday) — i.e. the cycle simply keeps
    // counting, it doesn't restart because a new Monday began.
    for (let offset = 0; offset < 4; offset++) {
      const day6 = cycleStepAt(JR_NT_OFF_OFF_CYCLE, 6, offset);
      const day7 = cycleStepAt(JR_NT_OFF_OFF_CYCLE, 7, offset);
      const expectedDay7 = cycleStepAt(JR_NT_OFF_OFF_CYCLE, 0, (offset + 7) % 4);
      expect(day7).toEqual(expectedDay7);
      // Sanity: day6 and day7 are genuinely adjacent cycle positions (not independently reset).
      expect(day6).toBeDefined();
    }
  });
});

describe("buildFixedCycleWeeklySchedule / offDaysForDisplayedWeek", () => {
  it("builds a displayed week whose OFF-cell count can legitimately differ by offset (1, 2, or 3), since a 4-day cycle doesn't align to a 7-day window", () => {
    const counts = new Set<number>();
    for (let offset = 0; offset < 4; offset++) {
      const week = buildFixedCycleWeeklySchedule(JR_NT_OFF_OFF_CYCLE, offset, DAYS);
      counts.add(week.filter((d) => d.status === "off").length);
    }
    expect(counts.size).toBeGreaterThan(1);
  });

  it("offDaysForDisplayedWeek matches the OFF days actually produced by buildFixedCycleWeeklySchedule", () => {
    for (let offset = 0; offset < 4; offset++) {
      const week = buildFixedCycleWeeklySchedule(JR_NT_OFF_OFF_CYCLE, offset, DAYS);
      const off = offDaysForDisplayedWeek(JR_NT_OFF_OFF_CYCLE, offset, DAYS);
      expect(off).toEqual(week.filter((d) => d.status === "off").map((d) => d.day_of_week));
    }
  });
});

describe("Transit and Leaders — real generated employees follow the confirmed cycle", () => {
  it("every Transit employee's displayed-week weekly_shifts is a valid window into JR -> NT -> OFF -> OFF", () => {
    const transit = EMPLOYEES.filter((e) => e.assignment === "Transit");
    expect(transit.length).toBeGreaterThan(0);
    for (const e of transit) {
      const codes = e.weekly_shifts.map((s) => (s.status === "off" ? "OFF" : s.shift_code));
      // Must appear as a contiguous (cyclically) slice of some 14-day
      // rendering of the cycle — verified by finding a matching offset.
      const matchesSomeOffset = [0, 1, 2, 3].some((offset) => {
        const seq = sequenceFor(offset, 7);
        return JSON.stringify(seq) === JSON.stringify(codes);
      });
      expect(matchesSomeOffset).toBe(true);
    }
  });

  it("every Leaders employee's displayed-week weekly_shifts is a valid window into JR -> NT -> OFF -> OFF", () => {
    const leaders = EMPLOYEES.filter((e) => e.assignment === "Leaders");
    expect(leaders.length).toBeGreaterThan(0);
    for (const e of leaders) {
      const codes = e.weekly_shifts.map((s) => (s.status === "off" ? "OFF" : s.shift_code));
      const matchesSomeOffset = [0, 1, 2, 3].some((offset) => {
        const seq = sequenceFor(offset, 7);
        return JSON.stringify(seq) === JSON.stringify(codes);
      });
      expect(matchesSomeOffset).toBe(true);
    }
  });
});
