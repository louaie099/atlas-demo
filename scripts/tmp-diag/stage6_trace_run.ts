// TEMPORARY instrumentation run (shift-generation.ts has a temporary
// __STAGE6_TRACE__ hook added for this one diagnostic; reverted immediately
// after this script is run). Captures the REAL greedy's per-pick sequence
// for Friday to resolve, empirically, why AP04 (which scores highest on a
// pure same-day+tail bucket-presence count) still gets 0 picks while
// NT01/N8 get 17/21 -- rather than continuing to hand-derive it.
(globalThis as any).__STAGE6_TRACE__ = [];
import { EMPLOYEES, CONFIG, DAYS_WITH_DATA } from "../../lib/seed-data";
import { generateDraftWeeklyPlan } from "../../lib/planning/generate-draft-plan";
import { flightDateFor } from "../../lib/flight-date";
import { Flight } from "../../lib/types";

const WEEK_START = "2026-10-05";
type Tpl = [string, string, string, string | null];
const TEMPLATE: Tpl[] = [
  ["01:01", "AT587", "Boeing 737-800", null], ["01:10", "AT272", "Boeing 737 MAX 8", null],
  ["01:10", "AT555", "Boeing 737 MAX 8", null], ["01:20", "AT533", "Boeing 737 MAX 8", null],
  ["01:35", "AT515", "Boeing 737-800", null], ["02:40", "AT248", "Boeing 787-8", null],
  ["06:00", "AT202", "Boeing 787-8", null], ["07:45", "AT942", "Boeing 737-800", null],
  ["07:50", "AT570", "Boeing 737-800", null], ["07:55", "AT946", "Boeing 737 MAX 8", null],
  ["07:55", "AT954", "Boeing 737-800", null], ["08:00", "AT206", "Boeing 787-9", "Canada"],
  ["08:00", "AT778", "Boeing 737 MAX 8", "Europe/Schengen"], ["08:05", "AT838", "Boeing 737-800", null],
  ["08:10", "AT760", "Boeing 737-800", "Europe/Schengen"], ["08:15", "AT792", "Boeing 737 MAX 8", null],
  ["08:20", "AT790", "Boeing 737-800", null], ["08:25", "AT1422", "Boeing 737-800", null],
  ["08:30", "AT1410", "Boeing 737-800", null], ["08:30", "AT409", "Boeing 737 MAX 8", null],
  ["10:00", "AT800", "Boeing 737 MAX 8", "UK/USA"], ["10:15", "AT818", "Boeing 737-800", null],
  ["10:30", "AT810", "Boeing 737 MAX 8", null], ["10:45", "AT850", "Boeing 737 MAX 8", null],
  ["11:00", "AT970", "Boeing 737-800", "Europe/Schengen"], ["11:15", "AT960", "Boeing 737-800", null],
  ["11:30", "AT984", "Boeing 737-800", null], ["11:45", "AT982", "Boeing 737-800", null],
  ["12:00", "AT441", "ATR 72", null], ["12:00", "AT930", "Boeing 737-800", null],
  ["12:15", "AT716", "Boeing 737-800", null], ["12:30", "AT732", "Boeing 737-800", null],
  ["12:45", "AT720", "Boeing 737 MAX 8", null], ["13:00", "AT944", "Boeing 737 MAX 8", null],
  ["13:15", "AT934", "Boeing 737-800", null], ["13:30", "AT413", "Boeing 737 MAX 8", null],
  ["13:30", "AT968", "Boeing 737-800", null], ["14:00", "AT1402", "Boeing 737 MAX 8", null],
  ["14:00", "AT910", "Boeing 787-8", null], ["14:30", "AT246", "Boeing 787-8", null],
  ["15:30", "AT250", "Boeing 787-8", null], ["16:00", "AT764", "Boeing 737-800", "Europe/Schengen"],
  ["16:30", "AT1412", "Boeing 737-800", null], ["17:00", "AT788", "Boeing 737 MAX 8", "Europe/Schengen"],
  ["17:30", "AT1424", "Boeing 737-800", null], ["18:30", "AT433", "Boeing 737 MAX 8", null],
  ["21:50", "AT401", "Boeing 737-800", null], ["21:50", "AT429", "ATR 72", null],
  ["21:55", "AT291", "Boeing 737 MAX 8", null], ["22:20", "AT527", "Boeing 737 MAX 8", null],
  ["22:25", "AT507", "Boeing 737 MAX 8", null], ["22:25", "AT1420", "Boeing 737 MAX 8", null],
  ["22:30", "AT591", "Boeing 737-800", null], ["22:35", "AT545", "Boeing 737 MAX 8", null],
  ["22:40", "AT501", "Boeing 787-9", null], ["22:40", "AT513", "Boeing 737-800", null],
  ["22:45", "AT267", "Boeing 737 MAX 8", null], ["22:45", "AT523", "Boeing 737 MAX 8", null],
  ["22:45", "AT559", "Boeing 737 MAX 8", null], ["22:50", "AT1400", "Boeing 737 MAX 8", null],
  ["22:55", "AT579", "Boeing 737-800", null], ["22:55", "AT220", "Boeing 737-800", null],
  ["23:00", "AT1446", "Boeing 737-800", null], ["23:05", "AT403", "Boeing 737-800", null],
  ["23:10", "AT440", "ATR 72", null], ["23:10", "AT293", "Boeing 737 MAX 8", null],
  ["23:15", "AT240", "Boeing 737-800", null], ["23:15", "AT431", "Boeing 737 MAX 8", null],
  ["23:20", "AT1460", "Boeing 737-800", null], ["23:45", "AT511", "Boeing 737-800", null],
];
function buildFlightsForDay(day: string, date: string): Flight[] {
  return TEMPLATE.map(([time, num, aircraft, destCat]) => ({
    id: `${num.toLowerCase()}-${day.toLowerCase()}`, flight_number: num, airline: "Royal Air Maroc",
    route: "CMN → XXX", origin: "CMN", destination: "XXX", aircraft, equipment_code: null, registration: null,
    callsign: null, terminal: "T1", scheduled_departure: time, scheduled_arrival: null, gate: null,
    boarding_window_start: null, boarding_window_end: null, status: "scheduled", booking_pressure: "normal",
    day_of_week: day, flight_date: date, week_start: WEEK_START, operator_type: "atlas_managed",
    destination_category: destCat, booked_passengers: null, seat_capacity: null,
  })) as unknown as Flight[];
}
const allFlights: Flight[] = DAYS_WITH_DATA.flatMap((day) => buildFlightsForDay(day, flightDateFor(WEEK_START, day)));
generateDraftWeeklyPlan(allFlights, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, "trace", WEEK_START);

const trace: any[] = (globalThis as any).__STAGE6_TRACE__;
const friTrace = trace.filter((t) => t.dayOfWeek === "Friday" && !t.marker);
console.log("Total Friday picks:", friTrace.length);
const byCode: Record<string, { count: number; scores: number[] }> = {};
for (const t of friTrace) {
  byCode[t.code] = byCode[t.code] ?? { count: 0, scores: [] };
  byCode[t.code].count++;
  byCode[t.code].scores.push(t.score);
}
console.log("\n=== Friday pick counts + score range by code ===");
for (const [code, v] of Object.entries(byCode).sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ${code}: ${v.count} picks, score range [${Math.min(...v.scores).toFixed(4)}, ${Math.max(...v.scores).toFixed(4)}]`);
}
console.log("\n=== First 15 picks in order (round, code, score, hardBuckets, tailBucketCount) ===");
for (let i = 0; i < Math.min(15, friTrace.length); i++) {
  const t = friTrace[i];
  console.log(`  round ${i + 1}: ${t.code} score=${t.score.toFixed(4)} hardBuckets=${t.hardBuckets} tailBucketCount=${t.tailBucketCountAtPick}`);
}
console.log("\n=== Last 10 picks in order ===");
for (let i = Math.max(0, friTrace.length - 10); i < friTrace.length; i++) {
  const t = friTrace[i];
  console.log(`  round ${i + 1}: ${t.code} score=${t.score.toFixed(4)} hardBuckets=${t.hardBuckets}`);
}

console.log("\n\n=== CALL BOUNDARIES (to separate Pass 1 discovery from Pass 2 real) ===");
let callIdx = 0;
const callStarts: number[] = [];
for (let i = 0; i < trace.length; i++) {
  if (trace[i].marker === "CALL_START") {
    callStarts.push(i);
    callIdx++;
    console.log(`  call #${callIdx} starts at trace index ${i}: day=${trace[i].dayOfWeek} hasNextDayDemand=${trace[i].hasNextDayDemand}`);
  }
}
// Segment picks between CALL_START markers, per day, to isolate each call's own picks.
console.log("\n=== Per-call pick distribution for Friday calls specifically ===");
let fridayCallNum = 0;
for (let c = 0; c < callStarts.length; c++) {
  const start = callStarts[c];
  const end = c + 1 < callStarts.length ? callStarts[c + 1] : trace.length;
  if (trace[start].dayOfWeek !== "Friday") continue;
  fridayCallNum++;
  const picks = trace.slice(start + 1, end).filter((t) => !t.marker);
  const dist: Record<string, number> = {};
  for (const p of picks) dist[p.code] = (dist[p.code] ?? 0) + 1;
  console.log(`  Friday call #${fridayCallNum} (hasNextDayDemand=${trace[start].hasNextDayDemand}): ${picks.length} picks ->`, dist);
}
