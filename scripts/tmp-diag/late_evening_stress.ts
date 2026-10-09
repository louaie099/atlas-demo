import { EMPLOYEES, SCRIPTED_FLIGHTS, CONFIG, DAYS_WITH_DATA } from "../../lib/seed-data";
import { generateWeeklyFlights } from "../../lib/flight-generator";
import { generateDraftWeeklyPlan } from "../../lib/planning/generate-draft-plan";
import { flightDateFor } from "../../lib/flight-date";
import { getShiftTimesAs, shiftCatalogForDate } from "../../lib/shift-templates";
import { Flight } from "../../lib/types";

// Use a REAL October 2026 week (POST-2026-09-20 regime), matching the
// live site's reported data -- the sandbox's own CURRENT_WEEK_START
// (2026-08-31) is PRE-regime and gives different shift catalog times.
const WEEK_START = "2026-10-05"; // a Monday

const baseFlights: Flight[] = [...SCRIPTED_FLIGHTS, ...generateWeeklyFlights()].map((f) => ({
  ...f,
  flight_date: flightDateFor(WEEK_START, f.day_of_week),
  week_start: WEEK_START,
}));

// Synthetic late-evening cluster on Thursday, mirroring the user's
// reported live pattern: 5 near-simultaneous flights 22:25-23:10,
// Gate+Boarding demand, one Dreamliner needing 2/2.
const TARGET_DAY = "Thursday";
const clusterFlights: Flight[] = [
  {
    id: "stress-at507", flight_number: "AT507", airline: "RAM", route: "CMN → ORY", origin: "CMN", destination: "ORY",
    aircraft: "Boeing 737-800", equipment_code: null, registration: null, callsign: null, terminal: "T1",
    scheduled_departure: "22:25", scheduled_arrival: null, gate: null, boarding_window_start: null, boarding_window_end: null,
    status: "scheduled", booking_pressure: "normal", day_of_week: TARGET_DAY,
    flight_date: flightDateFor(WEEK_START, TARGET_DAY), week_start: WEEK_START,
    operator_type: "atlas_managed", destination_category: "Europe/Schengen", booked_passengers: null, seat_capacity: null,
  } as unknown as Flight,
  {
    id: "stress-at501", flight_number: "AT501", airline: "RAM", route: "CMN → CDG", origin: "CMN", destination: "CDG",
    aircraft: "Boeing 787-9", equipment_code: null, registration: null, callsign: null, terminal: "T1",
    scheduled_departure: "22:40", scheduled_arrival: null, gate: null, boarding_window_start: null, boarding_window_end: null,
    status: "scheduled", booking_pressure: "normal", day_of_week: TARGET_DAY,
    flight_date: flightDateFor(WEEK_START, TARGET_DAY), week_start: WEEK_START,
    operator_type: "atlas_managed", destination_category: "Europe/Schengen", booked_passengers: null, seat_capacity: null,
  } as unknown as Flight,
  {
    id: "stress-at579", flight_number: "AT579", airline: "RAM", route: "CMN → MAD", origin: "CMN", destination: "MAD",
    aircraft: "Boeing 737-800", equipment_code: null, registration: null, callsign: null, terminal: "T1",
    scheduled_departure: "22:55", scheduled_arrival: null, gate: null, boarding_window_start: null, boarding_window_end: null,
    status: "scheduled", booking_pressure: "normal", day_of_week: TARGET_DAY,
    flight_date: flightDateFor(WEEK_START, TARGET_DAY), week_start: WEEK_START,
    operator_type: "atlas_managed", destination_category: "Europe/Schengen", booked_passengers: null, seat_capacity: null,
  } as unknown as Flight,
  {
    id: "stress-at403", flight_number: "AT403", airline: "RAM", route: "CMN → ALG", origin: "CMN", destination: "ALG",
    aircraft: "Boeing 737-800", equipment_code: null, registration: null, callsign: null, terminal: "T1",
    scheduled_departure: "23:05", scheduled_arrival: null, gate: null, boarding_window_start: null, boarding_window_end: null,
    status: "scheduled", booking_pressure: "normal", day_of_week: TARGET_DAY,
    flight_date: flightDateFor(WEEK_START, TARGET_DAY), week_start: WEEK_START,
    operator_type: "atlas_managed", destination_category: "Africa", booked_passengers: null, seat_capacity: null,
  } as unknown as Flight,
  {
    id: "stress-at1440", flight_number: "AT1440", airline: "RAM", route: "CMN → TUN", origin: "CMN", destination: "TUN",
    aircraft: "Boeing 737-800", equipment_code: null, registration: null, callsign: null, terminal: "T1",
    scheduled_departure: "23:10", scheduled_arrival: null, gate: null, boarding_window_start: null, boarding_window_end: null,
    status: "scheduled", booking_pressure: "normal", day_of_week: TARGET_DAY,
    flight_date: flightDateFor(WEEK_START, TARGET_DAY), week_start: WEEK_START,
    operator_type: "atlas_managed", destination_category: "Africa", booked_passengers: null, seat_capacity: null,
  } as unknown as Flight,
];

const allFlights = [...baseFlights, ...clusterFlights];

console.log("=== Shift catalog for", flightDateFor(WEEK_START, TARGET_DAY), "(should be POST-2026-09-20 regime) ===");
for (const code of ["AP01", "AP02", "AP03", "AP04", "NT01", "N8"]) {
  const t = getShiftTimesAs(code, flightDateFor(WEEK_START, TARGET_DAY));
  console.log(code, t.shift_start, "->", t.shift_end);
}

console.log("\n=== Running full draft plan generation for the week ===");
const plan = generateDraftWeeklyPlan(allFlights, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, "stress-test", WEEK_START);

console.log("\nTotal unfilled_duty issues (whole week):", plan.issues.filter((i: any) => i.type === "unfilled_duty").length);
const thursdayUnfilled = plan.issues.filter((i: any) => i.type === "unfilled_duty" && clusterFlights.some(f => f.id === (plan.dutiesByDay as any)?.[TARGET_DAY] ));
console.log("\n=== All unfilled_duty issues mentioning our synthetic flights ===");
for (const issue of plan.issues as any[]) {
  if (issue.type !== "unfilled_duty") continue;
  console.log(JSON.stringify(issue));
}

console.log("\n=== Roster entries for Thursday: shift code distribution ===");
const thursdayRoster = (plan.rosterEntries as any[]).filter((r) => r.day_of_week === TARGET_DAY && r.status === "working");
const byCode: Record<string, number> = {};
for (const r of thursdayRoster) byCode[r.shift_code] = (byCode[r.shift_code] ?? 0) + 1;
console.log("Working count:", thursdayRoster.length, "of", EMPLOYEES.length, "total employees");
console.log("By shift code:", byCode);

console.log("\n=== Employees whose Thursday shift REACHES 22:00-23:30 (by shift_code catalog reach) ===");
let reachCount = 0;
for (const r of thursdayRoster) {
  const code = r.shift_code;
  if (!code) continue;
  const times = getShiftTimesAs(code, flightDateFor(WEEK_START, TARGET_DAY));
  const [sh, sm] = times.shift_start.split(":").map(Number);
  const [eh, em] = times.shift_end.split(":").map(Number);
  let startMin = sh * 60 + sm;
  let endMin = eh * 60 + em;
  const overnight = endMin <= startMin;
  const reach = overnight ? 1440 : endMin;
  // does [22:00,23:30] overlap [startMin, reach)?
  if (startMin < 23 * 60 + 30 && 22 * 60 < reach) {
    reachCount++;
  }
}
console.log("Employees whose Thursday shift reaches 22:00-23:30:", reachCount);

console.log("\n=== Duties generated for our 5 synthetic flights ===");
const thursdayDuties = (plan.dutiesByDay as any)[TARGET_DAY] ?? [];
for (const f of clusterFlights) {
  const duties = thursdayDuties.filter((d: any) => d.flightId === f.id);
  console.log(f.flight_number, f.scheduled_departure, f.aircraft, "-> duties assigned:", duties.length, JSON.stringify(duties.map((d: any) => ({ role: d.role, emp: d.employeeId }))));
}

console.log("\n=== Configuration/hard-cap/rest issues (whole week) ===");
console.log("configurationIssues:", (plan.configurationIssues ?? []).length);
console.log("restViolationsPrevented:", (plan.restViolationsPrevented ?? []).length);
console.log("hardCapExclusions:", (plan as any).hardCapExclusions?.length ?? "n/a");
