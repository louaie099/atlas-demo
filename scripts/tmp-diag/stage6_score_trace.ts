// Empirical trace of Stage 6's hard-coverage math for the candidate codes
// the user asked about, against the REAL Friday demand from the full-day
// stress fixture -- answers sub-task 1 ("Explain Stage 6 decisions") with
// actual numbers, not just the analytical dominance argument.
import { EMPLOYEES, CONFIG, DAYS_WITH_DATA } from "../../lib/seed-data";
import { computeWeeklyStaffingRequirements } from "../../lib/planning/weekly-requirements";
import { aggregateDailyDemand } from "../../lib/planning/demand-aggregation";
import { shiftCatalogForDate } from "../../lib/shift-templates";
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
const FRI = "Friday";
const dateFor = (d: string) => flightDateFor(WEEK_START, d);
const allFlights: Flight[] = DAYS_WITH_DATA.flatMap((day) => buildFlightsForDay(day, dateFor(day)));
const allRequirements = computeWeeklyStaffingRequirements(allFlights, CONFIG);
const friDemand = aggregateDailyDemand(FRI, allFlights, allRequirements, CONFIG.checkin_demand_policy);

const BUCKET_MINUTES = 30;
const BUCKETS_PER_DAY = 48;
function timeToMinutes(t: string) { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function reachOfDayMinutes(entreeMin: number, sortieMin: number) { return sortieMin <= entreeMin ? 1440 : sortieMin; }

console.log("=== Friday raw Gate+Boarding demand by bucket (bucket index: demand) -- only nonzero shown ===");
let totalHardUnits = 0;
for (let i = 0; i < friDemand.buckets.length; i++) {
  const b = friDemand.buckets[i];
  const need = (b.demandByRole["Gate"] ?? 0) + (b.demandByRole["Boarding"] ?? 0);
  if (need > 0) {
    totalHardUnits += need;
    const startMin = i * BUCKET_MINUTES;
    const hh = String(Math.floor(startMin / 60) % 24).padStart(2, "0");
    const mm = String(startMin % 60).padStart(2, "0");
    console.log(`  bucket ${i} (${hh}:${mm}): Gate=${b.demandByRole["Gate"] ?? 0} Boarding=${b.demandByRole["Boarding"] ?? 0}`);
  }
}
console.log("Total Gate+Boarding demand-units across the day:", totalHardUnits);

console.log("\n=== Hard-coverage reach of each candidate code against this RAW (pre-assignment) demand ===");
const catalog = shiftCatalogForDate(dateFor(FRI));
for (const code of ["AP01", "AP02", "AP03", "AP04", "NT01", "N8", "MT03"]) {
  const times = catalog[code];
  if (!times) { console.log(`  ${code}: not in catalog for this date`); continue; }
  const entreeMin = timeToMinutes(times.entree);
  const sortieMin = timeToMinutes(times.sortie);
  const todayReach = reachOfDayMinutes(entreeMin, sortieMin);
  let coveredUnits = 0;
  const coveredBuckets: number[] = [];
  for (let i = 0; i < BUCKETS_PER_DAY; i++) {
    const bucketEnd = (i + 1) * BUCKET_MINUTES;
    if (entreeMin < bucketEnd && todayReach >= bucketEnd) {
      const b = friDemand.buckets[i];
      const need = (b.demandByRole["Gate"] ?? 0) + (b.demandByRole["Boarding"] ?? 0);
      if (need > 0) { coveredUnits += 1; coveredBuckets.push(i); } // 1 hard-coverage credit per bucket with ANY unmet need, matching Stage 6's per-bucket (not per-unit) accounting for a single employee
    }
  }
  console.log(`  ${code} (${times.entree}->${times.sortie}, reach-of-day=${todayReach}min): covers ${coveredUnits} of ${friDemand.buckets.filter(b => (b.demandByRole["Gate"]??0)+(b.demandByRole["Boarding"]??0) > 0).length} demand-bearing buckets`);
}

console.log("\n=== Exact demand-bearing buckets each code touches (bucket: time, Gate/Boarding demand) ===");
for (const code of ["AP01", "AP02", "AP03", "AP04", "NT01", "N8", "MT03"]) {
  const times = catalog[code];
  if (!times) continue;
  const entreeMin = timeToMinutes(times.entree);
  const sortieMin = timeToMinutes(times.sortie);
  const todayReach = reachOfDayMinutes(entreeMin, sortieMin);
  const touched: string[] = [];
  for (let i = 0; i < BUCKETS_PER_DAY; i++) {
    const bucketEnd = (i + 1) * BUCKET_MINUTES;
    if (entreeMin < bucketEnd && todayReach >= bucketEnd) {
      const b = friDemand.buckets[i];
      const need = (b.demandByRole["Gate"] ?? 0) + (b.demandByRole["Boarding"] ?? 0);
      if (need > 0) {
        const startMin = i * BUCKET_MINUTES;
        const hh = String(Math.floor(startMin / 60) % 24).padStart(2, "0");
        const mm = String(startMin % 60).padStart(2, "0");
        touched.push(`${hh}:${mm}(G${b.demandByRole["Gate"]??0}/B${b.demandByRole["Boarding"]??0})`);
      }
    }
  }
  console.log(`  ${code}: [${touched.join(", ")}]`);
}

// === NEXT-DAY TAIL CREDIT: the two-pass real pipeline (Pass 2) scores an
// overnight code using TOMORROW's demand as lookahead too (see
// generateFlexiblePoolShifts' bucketsCoveredBy, tailBucketCount). This is
// the piece a same-day-only comparison misses -- compute each code's real
// tail credit against Saturday's (structurally identical recurring
// template) early-morning demand, to see the FULL picture Stage 6 Pass 2
// actually scores on.
const SAT = "Saturday";
const satDemand = aggregateDailyDemand(SAT, allFlights, allRequirements, CONFIG.checkin_demand_policy);
console.log("\n=== Next-day (Saturday) tail credit for each OVERNIGHT code (first 13 buckets = 00:00-06:30) ===");
for (const code of ["AP03", "AP04", "NT01", "N8"]) {
  const times = catalog[code];
  if (!times) continue;
  const entreeMin = timeToMinutes(times.entree);
  const sortieMin = timeToMinutes(times.sortie);
  const overnight = sortieMin <= entreeMin;
  if (!overnight) { console.log(`  ${code}: not overnight, no tail`); continue; }
  let tailCredit = 0;
  const touched: string[] = [];
  for (let j = 0; j < 13; j++) {
    const bucketEnd = (j + 1) * BUCKET_MINUTES;
    if (sortieMin >= bucketEnd) {
      const b = satDemand.buckets[j];
      const need = (b.demandByRole["Gate"] ?? 0) + (b.demandByRole["Boarding"] ?? 0);
      if (need > 0) {
        tailCredit++;
        const startMin = j * BUCKET_MINUTES;
        const hh = String(Math.floor(startMin / 60)).padStart(2, "0");
        const mm = String(startMin % 60).padStart(2, "0");
        touched.push(`${hh}:${mm}(G${b.demandByRole["Gate"]??0}/B${b.demandByRole["Boarding"]??0})`);
      }
    }
  }
  console.log(`  ${code} (sortie ${times.sortie}): tail credit = ${tailCredit} buckets -> [${touched.join(", ")}]`);
}

console.log("\n=== FULL two-day hard-coverage credit (today's Friday buckets + tomorrow's Saturday tail) ===");
for (const code of ["AP01", "AP02", "AP03", "AP04", "NT01", "N8", "MT03"]) {
  const times = catalog[code];
  if (!times) continue;
  const entreeMin = timeToMinutes(times.entree);
  const sortieMin = timeToMinutes(times.sortie);
  const todayReach = reachOfDayMinutes(entreeMin, sortieMin);
  const overnight = sortieMin <= entreeMin;
  let credit = 0;
  for (let i = 0; i < BUCKETS_PER_DAY; i++) {
    const bucketEnd = (i + 1) * BUCKET_MINUTES;
    if (entreeMin < bucketEnd && todayReach >= bucketEnd) {
      const b = friDemand.buckets[i];
      if ((b.demandByRole["Gate"] ?? 0) + (b.demandByRole["Boarding"] ?? 0) > 0) credit++;
    }
  }
  if (overnight) {
    for (let j = 0; j < 13; j++) {
      const bucketEnd = (j + 1) * BUCKET_MINUTES;
      if (sortieMin >= bucketEnd) {
        const b = satDemand.buckets[j];
        if ((b.demandByRole["Gate"] ?? 0) + (b.demandByRole["Boarding"] ?? 0) > 0) credit++;
      }
    }
  }
  console.log(`  ${code}: total hard-coverage credit (Fri + Sat-tail) = ${credit}`);
}
