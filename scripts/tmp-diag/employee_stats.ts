import { EMPLOYEES } from "../../lib/seed-data";
import { isFlexibleGeneralPool } from "../../lib/planning/workforce-pools";

console.log("Total employees:", EMPLOYEES.length);
console.log("Active:", EMPLOYEES.filter(e => e.active).length);
console.log("Flexible General Pool:", EMPLOYEES.filter(isFlexibleGeneralPool).length);
const byAssignment: Record<string, number> = {};
for (const e of EMPLOYEES) byAssignment[e.assignment] = (byAssignment[e.assignment] ?? 0) + 1;
console.log("By assignment:", byAssignment);
const bySkillCount: Record<string, number> = {};
for (const e of EMPLOYEES) {
  for (const s of e.skills) bySkillCount[s] = (bySkillCount[s] ?? 0) + 1;
}
console.log("By skill:", bySkillCount);
console.log("Duty officers:", EMPLOYEES.filter(e => e.is_duty_officer).length);
