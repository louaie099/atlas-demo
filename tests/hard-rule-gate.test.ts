import { describe, it, expect } from "vitest";
import { enforceHardRulesOnGeneratedRoster } from "../lib/planning/hard-rule-gate";
import { CONFIG, EMPLOYEES } from "../lib/seed-data";
import { GeneratedShiftAssignment } from "../lib/planning/shift-generation";
import { isGenerationDrivenPopulation } from "../lib/planning/workforce-pools";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const WEEK = "2026-10-19";

function rosterFor(employeeId: string, codes: Record<string, string>) {
  const byDay: Record<string, GeneratedShiftAssignment[]> = {};
  for (const d of DAYS) byDay[d] = codes[d] ? [{ employeeId, dayOfWeek: d, shiftCode: codes[d], coversRoles: ["Gate"] }] : [];
  return byDay;
}
const flex = EMPLOYEES.find((e) => e.active && e.assignment === "General T1 Pool" && isGenerationDrivenPopulation(e))!;
const offOf = (res: ReturnType<typeof enforceHardRulesOnGeneratedRoster>, id: string) => DAYS.filter((d) => !res.shiftsByDay[d].some((g) => g.employeeId === id));
const isBlock = (off: string[]) => {
  const idx = off.map((d) => DAYS.indexOf(d));
  let runs = 0;
  for (let i = 0; i < 7; i++) if (idx.includes(i) && !idx.includes((i + 6) % 7)) runs++;
  return runs === 1;
};

describe("hard-rule gate", () => {
  it("leaves a compliant 5-work / 2-consecutive-OFF week untouched", () => {
    const input = rosterFor(flex.id, { Monday: "NR01", Tuesday: "NR01", Wednesday: "NR01", Thursday: "NR01", Friday: "NR01" });
    const res = enforceHardRulesOnGeneratedRoster({ daysOrder: DAYS, weekStart: WEEK, employees: [flex], shiftsByDay: input, config: CONFIG });
    expect(res.actions).toEqual([]);
    expect(offOf(res, flex.id)).toEqual(["Saturday", "Sunday"]);
  });

  it("re-forms a split OFF block into one consecutive block, never leaving a split", () => {
    const input = rosterFor(flex.id, { Monday: "NR01", Wednesday: "NR01", Thursday: "NR01", Friday: "NR01", Sunday: "NR01" }); // OFF Tue, Sat
    const res = enforceHardRulesOnGeneratedRoster({ daysOrder: DAYS, weekStart: WEEK, employees: [flex], shiftsByDay: input, config: CONFIG });
    const off = offOf(res, flex.id);
    expect(off.length).toBeGreaterThanOrEqual(CONFIG.minimum_off_days_per_planning_week);
    expect(isBlock(off)).toBe(true);
  });

  it("never touches fixed-cycle teams", () => {
    const fixed = EMPLOYEES.find((e) => e.active && (e.assignment === "Transit" || e.assignment === "Leaders"));
    if (!fixed) return;
    const input = rosterFor(fixed.id, { Monday: "JR01" });
    const res = enforceHardRulesOnGeneratedRoster({ daysOrder: DAYS, weekStart: WEEK, employees: [fixed], shiftsByDay: input, config: CONFIG });
    expect(res.actions).toEqual([]);
  });

  it("removes a shift that breaks the configured max shift duration", () => {
    const input = rosterFor(flex.id, { Monday: "NR01", Tuesday: "NR01", Wednesday: "NR01", Thursday: "NR01", Friday: "NR01" });
    const res = enforceHardRulesOnGeneratedRoster({ daysOrder: DAYS, weekStart: WEEK, employees: [flex], shiftsByDay: input, config: { ...CONFIG, max_continuous_shift_hours: 1 } });
    expect(res.actions.some((a) => a.rule === "max_continuous_shift_hours" && a.action === "removed")).toBe(true);
  });
});
