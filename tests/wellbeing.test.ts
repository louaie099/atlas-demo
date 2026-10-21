import { describe, it, expect } from "vitest";
import { computeWellbeing } from "@/lib/wellbeing";
import { AgentScheduleEntry } from "@/lib/types";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function entry(id: string, shifts: Record<string, [string, string]>): AgentScheduleEntry {
  return {
    employee: { id, name: id, assignment: "General T1 Pool" } as AgentScheduleEntry["employee"],
    dayOff: false,
    duties: [],
    proposedDuties: [],
    weeklyIssues: [],
    days: DAYS.map((d) => ({
      dayOfWeek: d,
      status: shifts[d] ? ("working" as const) : ("off" as const),
      shiftCode: shifts[d] ? "X" : null,
      shiftStart: shifts[d]?.[0] ?? null,
      shiftEnd: shifts[d]?.[1] ?? null,
      foreignCommitments: [],
      duties: [],
      issues: [],
    })),
  };
}

describe("computeWellbeing", () => {
  it("measures rest between consecutive working days and flags a breach", () => {
    // Wed 12:00-22:00 then Thu 06:00 -> 8h rest, below a 15h minimum
    const e = entry("a", { Wednesday: ["12:00", "22:00"], Thursday: ["06:00", "14:00"] });
    const r = computeWellbeing([e], 15).agents[0];
    expect(r.minRestHours).toBe(8);
    expect(r.restBreaches).toBe(1);
  });

  it("does not flag a long gap between a day shift and a next-day night shift", () => {
    // Wed 03:45-15:00 then Thu 21:30-06:30 -> 30.5h rest (Thu 21:30 is the NEXT day)
    const e = entry("a", { Wednesday: ["03:45", "15:00"], Thursday: ["21:30", "06:30"] });
    const r = computeWellbeing([e], 15).agents[0];
    expect(r.minRestHours).toBe(30.5);
    expect(r.restBreaches).toBe(0);
    expect(r.nights).toBe(2); // Wed starts before 04:00, Thu crosses midnight
  });

  it("counts a streak and ignores a gap", () => {
    const e = entry("a", { Monday: ["08:00", "17:00"], Tuesday: ["08:00", "17:00"], Thursday: ["08:00", "17:00"] });
    const r = computeWellbeing([e], 15).agents[0];
    expect(r.longestStreak).toBe(2);
    expect(r.workedDays).toBe(3);
    expect(r.minRestHours).toBe(15); // 17:00 -> 08:00 next day
    expect(r.restBreaches).toBe(0);
  });

  it("gives 100 when burden is identical and less when uneven", () => {
    const same = [entry("a", { Monday: ["08:00", "17:00"] }), entry("b", { Tuesday: ["08:00", "17:00"] })];
    expect(computeWellbeing(same, 15).loadBalanceIndex).toBe(100);
    const uneven = [
      entry("a", { Monday: ["08:00", "17:00"], Tuesday: ["08:00", "17:00"], Wednesday: ["08:00", "17:00"], Saturday: ["08:00", "17:00"] }),
      entry("b", { Monday: ["08:00", "17:00"] }),
    ];
    expect(computeWellbeing(uneven, 15).loadBalanceIndex!).toBeLessThan(80);
  });

  it("reports no index when fewer than two agents work", () => {
    expect(computeWellbeing([entry("a", { Monday: ["08:00", "17:00"] })], 15).loadBalanceIndex).toBeNull();
  });
});
