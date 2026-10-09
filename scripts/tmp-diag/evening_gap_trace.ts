import { EMPLOYEES, FLIGHTS, CONFIG, CURRENT_WEEK_START, DAYS_WITH_DATA } from "../../lib/seed-data";
import { generateDraftWeeklyPlan } from "../../lib/planning/generate-draft-plan";
import { computeWeeklyStaffingRequirements } from "../../lib/planning/weekly-requirements";
import { getRequirementWindow } from "../../lib/planning/requirement-window";
import { getShiftTimesAs } from "../../lib/shift-templates";

const plan = generateDraftWeeklyPlan(FLIGHTS, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, "diag", CURRENT_WEEK_START);

const unfilled = plan.issues.filter((i: any) => i.type === "unfilled_duty");
console.log("Total unfilled_duty issues:", unfilled.length);
for (const issue of unfilled) {
  console.log(JSON.stringify(issue));
}

console.log("\n--- Flights in the 22:00-23:30 window ---");
const lateFlights = FLIGHTS.filter((f) => {
  const [h, m] = f.scheduled_departure.split(":").map(Number);
  const mins = h * 60 + m;
  return mins >= 22 * 60 && mins <= 23 * 60 + 30;
});
for (const f of lateFlights) {
  console.log(f.day_of_week, f.flight_number, f.scheduled_departure, f.aircraft, f.id);
}

console.log("\n--- Shift code reach check ---");
for (const code of ["AP01", "AP02", "AP03", "AP04", "NT01", "N8"]) {
  try {
    const t = getShiftTimesAs(code, CURRENT_WEEK_START);
    console.log(code, t.shift_start, "->", t.shift_end);
  } catch (e) {
    console.log(code, "ERROR", (e as Error).message);
  }
}
