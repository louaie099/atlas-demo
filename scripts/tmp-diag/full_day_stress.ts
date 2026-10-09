import { EMPLOYEES, CONFIG, DAYS_WITH_DATA } from "../../lib/seed-data";
import { generateDraftWeeklyPlan } from "../../lib/planning/generate-draft-plan";
import { flightDateFor } from "../../lib/flight-date";
import { getShiftTimesAs } from "../../lib/shift-templates";
import { Flight } from "../../lib/types";

// REAL October 2026 week containing the live site's reported date
// (2026-10-09, a Friday) -- Monday-start, POST-2026-09-20 regime.
const WEEK_START = "2026-10-05";

// Faithful reconstruction of the LIVE site's own daily flight template,
// read directly off Live Operations for 2026-10-09 AND 2026-10-10 (both
// read-only page dumps) -- the live demo runs the SAME ~70-flight bank
// every single day, so one canonical day, applied to all 7 days, is a
// faithful representation, not a guess. Each tuple:
// [time, flightNumber, aircraft, destinationCategory]
// destinationCategory drives Profiling/Mesure via ram-staffing-matrix.ts;
// Gate/Boarding count is auto-derived from aircraft (Dreamliner = 2/2).
type Tpl = [string, string, string, string | null];

const TEMPLATE: Tpl[] = [
  ["01:01", "AT587", "Boeing 737-800", null],
  ["01:10", "AT272", "Boeing 737 MAX 8", null],
  ["01:10", "AT555", "Boeing 737 MAX 8", null],
  ["01:20", "AT533", "Boeing 737 MAX 8", null],
  ["01:35", "AT515", "Boeing 737-800", null],
  ["02:40", "AT248", "Boeing 787-8", null], // MED -- not Profiling/Mesure gated category live; dreamliner Gate/Boarding 2/2 only
  ["06:00", "AT202", "Boeing 787-8", null], // JFK -- observed as 2/2 Gate+Boarding only, no Profiling/Mesure shown live
  ["07:45", "AT942", "Boeing 737-800", null],
  ["07:50", "AT570", "Boeing 737-800", null],
  ["07:55", "AT946", "Boeing 737 MAX 8", null],
  ["07:55", "AT954", "Boeing 737-800", null],
  ["08:00", "AT206", "Boeing 787-9", "Canada"], // YUL -- observed Profiling 2/2 + Mesure 4/4
  ["08:00", "AT778", "Boeing 737 MAX 8", "Europe/Schengen"], // CDG -- observed Profiling 1/1
  ["08:05", "AT838", "Boeing 737-800", null],
  ["08:10", "AT760", "Boeing 737-800", "Europe/Schengen"], // ORY -- observed Profiling 1/1
  ["08:15", "AT792", "Boeing 737 MAX 8", null],
  ["08:20", "AT790", "Boeing 737-800", null],
  ["08:25", "AT1422", "Boeing 737-800", null],
  ["08:30", "AT1410", "Boeing 737-800", null],
  ["08:30", "AT409", "Boeing 737 MAX 8", null],
  ["10:00", "AT800", "Boeing 737 MAX 8", "UK/USA"], // LHR -- observed Profiling 1/1 + Mesure 4/4
  ["10:15", "AT818", "Boeing 737-800", null],
  ["10:30", "AT810", "Boeing 737 MAX 8", null],
  ["10:45", "AT850", "Boeing 737 MAX 8", null],
  ["11:00", "AT970", "Boeing 737-800", "Europe/Schengen"], // MAD -- observed Profiling 1/1
  ["11:15", "AT960", "Boeing 737-800", null],
  ["11:30", "AT984", "Boeing 737-800", null],
  ["11:45", "AT982", "Boeing 737-800", null],
  ["12:00", "AT441", "ATR 72", null],
  ["12:00", "AT930", "Boeing 737-800", null],
  ["12:15", "AT716", "Boeing 737-800", null],
  ["12:30", "AT732", "Boeing 737-800", null],
  ["12:45", "AT720", "Boeing 737 MAX 8", null],
  ["13:00", "AT944", "Boeing 737 MAX 8", null],
  ["13:15", "AT934", "Boeing 737-800", null],
  ["13:30", "AT413", "Boeing 737 MAX 8", null],
  ["13:30", "AT968", "Boeing 737-800", null],
  ["14:00", "AT1402", "Boeing 737 MAX 8", null],
  ["14:00", "AT910", "Boeing 787-8", null],
  ["14:30", "AT246", "Boeing 787-8", null],
  ["15:30", "AT250", "Boeing 787-8", null],
  ["16:00", "AT764", "Boeing 737-800", "Europe/Schengen"], // ORY -- observed Profiling 1/1
  ["16:30", "AT1412", "Boeing 737-800", null],
  ["17:00", "AT788", "Boeing 737 MAX 8", "Europe/Schengen"], // CDG -- observed Profiling 1/1
  ["17:30", "AT1424", "Boeing 737-800", null],
  ["18:30", "AT433", "Boeing 737 MAX 8", null],
  ["21:50", "AT401", "Boeing 737-800", null],
  ["21:50", "AT429", "ATR 72", null],
  ["21:55", "AT291", "Boeing 737 MAX 8", null],
  ["22:20", "AT527", "Boeing 737 MAX 8", null],
  ["22:25", "AT507", "Boeing 737 MAX 8", null],
  ["22:25", "AT1420", "Boeing 737 MAX 8", null],
  ["22:30", "AT591", "Boeing 737-800", null],
  ["22:35", "AT545", "Boeing 737 MAX 8", null],
  ["22:40", "AT501", "Boeing 787-9", null], // DKR -- observed Gate 2/2 Boarding 2/2 (dreamliner), no profiling/mesure shown live
  ["22:40", "AT513", "Boeing 737-800", null],
  ["22:45", "AT267", "Boeing 737 MAX 8", null],
  ["22:45", "AT523", "Boeing 737 MAX 8", null],
  ["22:45", "AT559", "Boeing 737 MAX 8", null],
  ["22:50", "AT1400", "Boeing 737 MAX 8", null],
  ["22:55", "AT579", "Boeing 737-800", null],
  ["22:55", "AT220", "Boeing 737-800", null],
  ["23:00", "AT1446", "Boeing 737-800", null],
  ["23:05", "AT403", "Boeing 737-800", null],
  ["23:10", "AT440", "ATR 72", null],
  ["23:10", "AT293", "Boeing 737 MAX 8", null],
  ["23:15", "AT240", "Boeing 737-800", null],
  ["23:15", "AT431", "Boeing 737 MAX 8", null],
  ["23:20", "AT1460", "Boeing 737-800", null],
  ["23:45", "AT511", "Boeing 737-800", null],
];

function buildFlightsForDay(day: string, date: string): Flight[] {
  return TEMPLATE.map(([time, num, aircraft, destCat], i) => ({
    id: `${num.toLowerCase()}-${day.toLowerCase()}`,
    flight_number: num,
    airline: "Royal Air Maroc",
    route: `CMN → XXX`,
    origin: "CMN",
    destination: "XXX",
    aircraft,
    equipment_code: null,
    registration: null,
    callsign: null,
    terminal: "T1",
    scheduled_departure: time,
    scheduled_arrival: null,
    gate: null,
    boarding_window_start: null,
    boarding_window_end: null,
    status: "scheduled",
    booking_pressure: "normal",
    day_of_week: day,
    flight_date: date,
    week_start: WEEK_START,
    operator_type: "atlas_managed",
    destination_category: destCat,
    booked_passengers: null,
    seat_capacity: null,
  })) as unknown as Flight[];
}

const allFlights: Flight[] = DAYS_WITH_DATA.flatMap((day) =>
  buildFlightsForDay(day, flightDateFor(WEEK_START, day))
);

console.log("Total flights across the week:", allFlights.length, "(", TEMPLATE.length, "per day x 7)");

console.log("\n=== Running full draft plan generation for the real October week ===");
const plan = generateDraftWeeklyPlan(allFlights, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, "full-day-stress", WEEK_START);

const unfilled = plan.issues.filter((i: any) => i.type === "unfilled_duty");
console.log("\nTotal unfilled_duty issues (whole week):", unfilled.length);

// Focus on Friday (2026-10-09) evening through its own end-of-day, PLUS
// Saturday's own early-morning buckets (00:00-03:00) as "until 3am the
// following morning."
const FOCUS_DAY = "Friday";
const NEXT_DAY = "Saturday";

console.log(`\n=== unfilled_duty issues on ${FOCUS_DAY} ===`);
const fridayUnfilled = unfilled.filter((i: any) => i.dayOfWeek === FOCUS_DAY);
for (const issue of fridayUnfilled) console.log(JSON.stringify(issue));
console.log(`Count: ${fridayUnfilled.length}`);

console.log(`\n=== unfilled_duty issues on ${NEXT_DAY} (captures "until 3am" carryover) ===`);
const saturdayUnfilled = unfilled.filter((i: any) => i.dayOfWeek === NEXT_DAY);
for (const issue of saturdayUnfilled) console.log(JSON.stringify(issue));
console.log(`Count: ${saturdayUnfilled.length}`);

// Map unfilled requirementIds back to flight/time for readability
const dutiesFriday = (plan.dutiesByDay as any)[FOCUS_DAY] ?? [];
const flightsByDay = new Map<string, Flight[]>();
for (const day of DAYS_WITH_DATA) flightsByDay.set(day, buildFlightsForDay(day, flightDateFor(WEEK_START, day)));

function describeUnfilled(issue: any, day: string) {
  // requirementId isn't directly on the Flight; we match by scanning the
  // plan's own requirement list is not exposed here, so instead report
  // using dutiesByDay context: cross-reference via flight ids embedded in
  // requirementId naming convention used by weekly-requirements.ts (role
  // + flight id). Fallback: just print the raw issue plus day.
  return `${day}: ${JSON.stringify(issue)}`;
}

console.log("\n=== Shift code distribution: Friday ===");
const fridayRoster = (plan.rosterEntries as any[]).filter((r) => r.day_of_week === FOCUS_DAY && r.status === "working");
const byCodeFri: Record<string, number> = {};
for (const r of fridayRoster) byCodeFri[r.shift_code] = (byCodeFri[r.shift_code] ?? 0) + 1;
console.log("Working:", fridayRoster.length, "/", EMPLOYEES.length);
console.log(byCodeFri);

console.log("\n=== Shift code distribution: Saturday ===");
const saturdayRoster = (plan.rosterEntries as any[]).filter((r) => r.day_of_week === NEXT_DAY && r.status === "working");
const byCodeSat: Record<string, number> = {};
for (const r of saturdayRoster) byCodeSat[r.shift_code] = (byCodeSat[r.shift_code] ?? 0) + 1;
console.log("Working:", saturdayRoster.length, "/", EMPLOYEES.length);
console.log(byCodeSat);

// Required vs eligible capacity per 30-min bucket for Gate+Boarding,
// 22:00 Friday through 03:00 Saturday.
function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
console.log("\n=== Required Gate+Boarding units per flight, Friday 22:00 - Saturday 03:00 ===");
const lateFriday = TEMPLATE.filter(([t]) => timeToMinutes(t) >= 22 * 60);
const earlySaturday = TEMPLATE.filter(([t]) => timeToMinutes(t) <= 3 * 60);
console.log("Friday 22:00+:", lateFriday.length, "flights ->", lateFriday.map(t => t[1]).join(", "));
console.log("Saturday 00:00-03:00:", earlySaturday.length, "flights ->", earlySaturday.map(t => t[1]).join(", "));

console.log("\n=== Duties actually assigned for Friday's late flights (22:00+) ===");
for (const [time, num] of lateFriday) {
  const flightId = `${num.toLowerCase()}-friday`;
  const duties = dutiesFriday.filter((d: any) => d.flightId === flightId);
  const roles = duties.map((d: any) => d.role).sort();
  console.log(time, num, "-> assigned roles:", JSON.stringify(roles));
}

console.log("\n=== Duties actually assigned for Saturday's early flights (00:00-03:00) ===");
const dutiesSaturday = (plan.dutiesByDay as any)[NEXT_DAY] ?? [];
for (const [time, num] of earlySaturday) {
  const flightId = `${num.toLowerCase()}-saturday`;
  const duties = dutiesSaturday.filter((d: any) => d.flightId === flightId);
  const roles = duties.map((d: any) => d.role).sort();
  console.log(time, num, "-> assigned roles:", JSON.stringify(roles));
}

console.log("\n=== Week-wide summary ===");
console.log("configurationIssues:", (plan.configurationIssues ?? []).length);
console.log("restViolationsPrevented:", (plan.restViolationsPrevented ?? []).length);
