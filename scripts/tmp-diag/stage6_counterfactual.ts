import { EMPLOYEES, CONFIG, DAYS_WITH_DATA } from "../../lib/seed-data";
import { generateDraftWeeklyPlan } from "../../lib/planning/generate-draft-plan";
import { computeWeeklyStaffingRequirements } from "../../lib/planning/weekly-requirements";
import { generateDutiesForDay } from "../../lib/planning/duty-generation";
import { GeneratedShiftAssignment, PriorDayShiftMap } from "../../lib/planning/shift-generation";
import { isFlexibleGeneralPool } from "../../lib/planning/workforce-pools";
import { restHoursBetween } from "../../lib/roster-generation";
import { getShiftTimesAs } from "../../lib/shift-templates";
import { flightDateFor } from "../../lib/flight-date";
import { Flight, Employee, WeeklyPlanRosterEntry } from "../../lib/types";

const WEEK_START = "2026-10-05";
const MIN_REST = CONFIG.minimum_rest_hours;
console.log("Configured minimum_rest_hours:", MIN_REST);

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
const allRequirements = computeWeeklyStaffingRequirements(allFlights, CONFIG);

console.log("\n=== BASELINE: full week generation ===");
const plan = generateDraftWeeklyPlan(allFlights, EMPLOYEES, [], CONFIG, DAYS_WITH_DATA, "counterfactual", WEEK_START);
const baselineUnfilled = plan.issues.filter((i: any) => i.type === "unfilled_duty");
console.log("Baseline total unfilled (week):", baselineUnfilled.length);

const THU = "Thursday", FRI = "Friday", SAT = "Saturday";
const dateFor = (d: string) => flightDateFor(WEEK_START, d);

function effectiveShiftsForDay(day: string): Map<string, { shift_start: string; shift_end: string; shift_code: string } | null> {
  const rows = (plan.rosterEntries as any[]).filter((r) => r.day_of_week === day);
  const m = new Map<string, { shift_start: string; shift_end: string; shift_code: string } | null>();
  for (const r of rows) {
    if (r.status !== "working" || !r.shift_code) { m.set(r.employee_id, null); continue; }
    const t = getShiftTimesAs(r.shift_code, dateFor(day));
    m.set(r.employee_id, { ...t, shift_code: r.shift_code });
  }
  return m;
}

const thuShifts = effectiveShiftsForDay(THU);
const friShifts = effectiveShiftsForDay(FRI);
const satShifts = effectiveShiftsForDay(SAT);

console.log("\n=== Friday shift-code distribution (baseline) ===");
const byCode: Record<string, number> = {};
for (const [, v] of friShifts) if (v) byCode[v.shift_code] = (byCode[v.shift_code] ?? 0) + 1;
console.log(byCode);

// Candidate swap pool: flexible-pool employees working Friday on a
// daytime-only code (MT03/NR01/JR01/JR02) with Gate or Boarding skill --
// i.e. people Stage 6 chose NOT to send onto an evening/night-reaching
// code, who COULD physically do Gate/Boarding work.
const DAYTIME_CODES = new Set(["MT01", "MT02", "MT03", "NR01", "NR02", "JR01", "JR02"]);
const empById = new Map(EMPLOYEES.map((e) => [e.id, e]));

interface SwapCandidate { employeeId: string; name: string; currentCode: string; legalFor: string[]; }
const candidates: SwapCandidate[] = [];
for (const [empId, shift] of friShifts) {
  if (!shift || !DAYTIME_CODES.has(shift.shift_code)) continue;
  const emp = empById.get(empId);
  if (!emp || !isFlexibleGeneralPool(emp)) continue;
  if (!emp.skills.includes("Gate") && !emp.skills.includes("Boarding")) continue;

  const legalFor: string[] = [];
  for (const candidateCode of ["N8", "NT01", "AP03", "AP04"]) {
    const times = getShiftTimesAs(candidateCode, dateFor(FRI));
    let ok = true;
    const prior = thuShifts.get(empId);
    if (prior) {
      const restBefore = restHoursBetween(prior.shift_start, prior.shift_end, times.shift_start);
      if (restBefore < MIN_REST) ok = false;
    }
    const next = satShifts.get(empId);
    if (ok && next) {
      const restAfter = restHoursBetween(times.shift_start, times.shift_end, next.shift_start);
      if (restAfter < MIN_REST) ok = false;
    }
    if (ok) legalFor.push(candidateCode);
  }
  if (legalFor.length > 0) {
    candidates.push({ employeeId: empId, name: emp.name, currentCode: shift.shift_code, legalFor });
  }
}

console.log(`\n=== Swap candidates: Friday daytime-code employees legally eligible for an evening/night code ===`);
console.log(`Total eligible: ${candidates.length} (out of ${[...friShifts.values()].filter(v => v && DAYTIME_CODES.has(v.shift_code)).length} on daytime codes with Gate/Boarding skill)`);
for (const c of candidates.slice(0, 20)) {
  console.log(`  ${c.name} (${c.employeeId}): ${c.currentCode} -> legal for [${c.legalFor.join(", ")}]`);
}
if (candidates.length > 20) console.log(`  ... and ${candidates.length - 20} more`);

function buildGeneratedShifts(day: string, overrides: Map<string, string>): GeneratedShiftAssignment[] {
  const shifts = effectiveShiftsForDay(day);
  const out: GeneratedShiftAssignment[] = [];
  for (const [empId, shift] of shifts) {
    const code = overrides.get(empId) ?? shift?.shift_code;
    if (code) out.push({ employeeId: empId, dayOfWeek: day, shiftCode: code, coversRoles: [] });
  }
  return out;
}

function priorDayMapFrom(shifts: Map<string, { shift_start: string; shift_end: string; shift_code: string } | null>): PriorDayShiftMap {
  const m: PriorDayShiftMap = new Map();
  for (const [empId, v] of shifts) m.set(empId, v ? { shift_start: v.shift_start, shift_end: v.shift_end } : null);
  return m;
}

// CRITICAL: duty-generation.ts's dayEffectivePool substitutes
// rest_before_shift_hours from `actualRestHoursByDay` when given, falling
// back to the employee's STATIC `rest_before_shift_hours` field otherwise
// -- which is null for every generation-driven (flexible-pool/Profiling/
// Mesure/foreign) employee, since they have no fixed template (see
// lib/types.ts's Employee doc comment). Omitting this input, as the real
// pipeline never does, makes scoreCandidates see "no rest data" for
// nearly the whole flexible pool and fail them on the hard rest check --
// producing a sea of FALSE unfilled_duty results that have nothing to do
// with real capacity. Must compute this exactly as generate-draft-plan.ts
// does: real rest, from each employee's REAL previous-day effective shift.
function actualRestHoursForDay(day: string, previousDayShift: PriorDayShiftMap, generatedShifts: GeneratedShiftAssignment[]): Map<string, number> {
  const m = new Map<string, number>();
  const todayCodeByEmp = new Map(generatedShifts.map((g) => [g.employeeId, g.shiftCode]));
  for (const emp of EMPLOYEES) {
    const code = todayCodeByEmp.get(emp.id);
    if (!code) continue;
    const today = getShiftTimesAs(code, dateFor(day));
    const prior = previousDayShift.get(emp.id);
    if (!prior) continue; // no known prior-day shift -- real pipeline falls back to static field too
    const rest = restHoursBetween(prior.shift_start, prior.shift_end, today.shift_start);
    m.set(`${emp.id}|${day}`, rest);
  }
  return m;
}

function countUnfilled(day: string, generatedShifts: GeneratedShiftAssignment[], previousDayShift: PriorDayShiftMap) {
  const actualRest = actualRestHoursForDay(day, previousDayShift, generatedShifts);
  const result = generateDutiesForDay(day, allRequirements, allFlights, EMPLOYEES, generatedShifts, [], CONFIG, dateFor(day), actualRest, new Map(), new Map(), undefined, previousDayShift);
  return result;
}

console.log("\n=== BASELINE Stage 9 replay (sanity check against full-week run) ===");
const baselineFriGen = buildGeneratedShifts(FRI, new Map());
const baselineFriResult = countUnfilled(FRI, baselineFriGen, priorDayMapFrom(thuShifts));
console.log("Friday unfilled (standalone Stage-9 replay):", baselineFriResult.unfilled.length);
for (const u of baselineFriResult.unfilled) console.log("  ", JSON.stringify(u));

const baselineSatGen = buildGeneratedShifts(SAT, new Map());
const baselineSatResult = countUnfilled(SAT, baselineSatGen, priorDayMapFrom(friShifts));
console.log("Saturday unfilled (standalone Stage-9 replay):", baselineSatResult.unfilled.length);

// === COUNTERFACTUAL: swap ALL legally-eligible candidates to N8 (the
// most efficient evening/night code: starts latest, same 06:30 reach) ===
const overrides = new Map<string, string>();
for (const c of candidates) {
  const target = c.legalFor.includes("N8") ? "N8" : c.legalFor[0];
  overrides.set(c.employeeId, target);
}
console.log(`\n=== COUNTERFACTUAL: swap all ${overrides.size} eligible candidates onto an evening/night code ===`);
const cfFriGen = buildGeneratedShifts(FRI, overrides);
const cfByCode: Record<string, number> = {};
for (const g of cfFriGen) cfByCode[g.shiftCode] = (cfByCode[g.shiftCode] ?? 0) + 1;
console.log("Modified Friday shift-code distribution:", cfByCode);

const cfFriResult = countUnfilled(FRI, cfFriGen, priorDayMapFrom(thuShifts));
console.log("\nFriday unfilled AFTER swap:", cfFriResult.unfilled.length);
for (const u of cfFriResult.unfilled) console.log("  ", JSON.stringify(u));

// Build Friday's effective shifts AS MODIFIED, to feed Saturday's carryover
const modifiedFriShifts = new Map(friShifts);
for (const [empId, code] of overrides) {
  const t = getShiftTimesAs(code, dateFor(FRI));
  modifiedFriShifts.set(empId, { ...t, shift_code: code });
}
const cfSatGen = buildGeneratedShifts(SAT, new Map()); // Saturday's own Stage-6 output unchanged
const cfSatResult = countUnfilled(SAT, cfSatGen, priorDayMapFrom(modifiedFriShifts));
console.log("\nSaturday unfilled AFTER Friday swap (carryover effect):", cfSatResult.unfilled.length);
for (const u of cfSatResult.unfilled) console.log("  ", JSON.stringify(u));

console.log("\n=== Net comparison (swap-from-daytime) ===");
console.log(`Friday:   baseline ${baselineFriResult.unfilled.length} -> after swap ${cfFriResult.unfilled.length}`);
console.log(`Saturday: baseline ${baselineSatResult.unfilled.length} -> after swap ${cfSatResult.unfilled.length}`);

// === SECOND COUNTERFACTUAL: is there genuinely IDLE capacity? Find
// flexible-pool Gate/Boarding-qualified employees who are OFF on Friday
// (no roster entry / status "off") and test whether ADDING them onto an
// evening/night code -- without removing anyone else's daytime coverage
// -- is even legal, and if so, whether it helps. This distinguishes
// "genuine shortage" (nobody spare, or sparing them is illegal) from
// "suboptimal distribution" (spare legal capacity Stage 6 simply didn't use).
console.log("\n=== SECOND COUNTERFACTUAL: adding genuinely IDLE (OFF) employees onto an evening code ===");
const offCandidates: SwapCandidate[] = [];
for (const emp of EMPLOYEES) {
  if (!isFlexibleGeneralPool(emp)) continue;
  if (!emp.skills.includes("Gate") && !emp.skills.includes("Boarding")) continue;
  const fri = friShifts.get(emp.id);
  if (fri) continue; // already working Friday -- not idle
  const legalFor: string[] = [];
  for (const candidateCode of ["N8", "NT01", "AP03", "AP04"]) {
    const times = getShiftTimesAs(candidateCode, dateFor(FRI));
    let ok = true;
    const prior = thuShifts.get(emp.id);
    if (prior) {
      if (restHoursBetween(prior.shift_start, prior.shift_end, times.shift_start) < MIN_REST) ok = false;
    }
    const next = satShifts.get(emp.id);
    if (ok && next) {
      if (restHoursBetween(times.shift_start, times.shift_end, next.shift_start) < MIN_REST) ok = false;
    }
    if (ok) legalFor.push(candidateCode);
  }
  if (legalFor.length > 0) offCandidates.push({ employeeId: emp.id, name: emp.name, currentCode: "OFF", legalFor });
}
const totalOffFlexibleGateBoarding = EMPLOYEES.filter(
  (e) => isFlexibleGeneralPool(e) && (e.skills.includes("Gate") || e.skills.includes("Boarding")) && !friShifts.get(e.id)
).length;
console.log(`Flexible-pool Gate/Boarding-qualified employees OFF on Friday: ${totalOffFlexibleGateBoarding}`);
console.log(`Of those, legally addable to an evening/night code without violating rest: ${offCandidates.length}`);
for (const c of offCandidates) console.log(`  ${c.name} (${c.employeeId}): OFF -> legal for [${c.legalFor.join(", ")}]`);

if (offCandidates.length > 0) {
  const addOverrides = new Map<string, string>();
  for (const c of offCandidates) addOverrides.set(c.employeeId, c.legalFor.includes("N8") ? "N8" : c.legalFor[0]);
  const addFriGen = buildGeneratedShifts(FRI, addOverrides);
  // buildGeneratedShifts reads effectiveShiftsForDay which won't include
  // OFF employees' overrides automatically (they have no baseline entry) --
  // add them explicitly.
  for (const [empId, code] of addOverrides) {
    if (!addFriGen.find((g) => g.employeeId === empId)) addFriGen.push({ employeeId: empId, dayOfWeek: FRI, shiftCode: code, coversRoles: [] });
  }
  const addFriResult = countUnfilled(FRI, addFriGen, priorDayMapFrom(thuShifts));
  console.log(`\nFriday unfilled after ADDING ${offCandidates.length} idle employees: ${addFriResult.unfilled.length} (baseline was ${baselineFriResult.unfilled.length})`);
  for (const u of addFriResult.unfilled) console.log("  ", JSON.stringify(u));
} else {
  console.log("\nNo idle, legally-addable candidates exist -- the shortage cannot be closed by using spare people, only by changing who is rostered off.");
}

// === METHODOLOGY CHECK: did any of the "idle" offCandidates actually have
// an OVERNIGHT shift on THURSDAY that carries over into Friday morning
// (covering the 01:01-02:40 AT587/AT272/AT555/AT533/AT515/AT248 cluster)?
// If so, giving them a brand-new, SEPARATE Friday evening/night shift would
// (per duty-generation.ts's own documented design: "Their own today-dated
// shift always takes priority when one exists" -- ownShift ?? carryover,
// NEVER both) silently revoke their carryover-based coverage of Friday's
// early morning, since the dayEffectivePool can only represent ONE
// effective shift per employee per day. This would make the "regression"
// a test-harness artifact (double-booking an employee across two
// representations of the same day), not a genuine Stage 9 ordering bug.
console.log("\n=== METHODOLOGY CHECK: do offCandidates already cover Friday-morning via Thursday carryover? ===");
const OVERNIGHT_CODES = new Set(["AP03", "AP04", "NT01", "N8"]);
for (const c of offCandidates) {
  const thu = thuShifts.get(c.employeeId);
  if (thu && OVERNIGHT_CODES.has(thu.shift_code)) {
    console.log(`  ${c.name} (${c.employeeId}): Thursday = ${thu.shift_code} (${thu.shift_start}->${thu.shift_end}) -- OVERNIGHT, carries into Friday morning!`);
  } else {
    console.log(`  ${c.name} (${c.employeeId}): Thursday = ${thu ? thu.shift_code : "OFF/none"} -- no carryover risk`);
  }
}

// Cross-check: in baseline (no overrides at all), was AT587's cluster
// already filled, and by whom? This tells us whether these particular
// offCandidates were already the ones covering it via carryover.
console.log("\n=== Baseline Friday duties for the early-morning cluster (AT587/AT272/AT555/AT533/AT515/AT248) ===");
const earlyFlightIds = new Set(["at587-friday", "at272-friday", "at555-friday", "at533-friday", "at515-friday", "at248-friday"]);
for (const d of baselineFriResult.duties.filter((d) => earlyFlightIds.has(d.flightId))) {
  const emp = empById.get(d.employeeId);
  console.log(`  ${d.flightId} role=${d.role} -> ${emp?.name} (${d.employeeId})`);
}

// === COUNTERFACTUAL #2b (CORRECTED): the previous "idle" filter only
// checked for an explicit FRIDAY roster row -- it did NOT exclude people
// who are already covering Friday's early-morning hours via an OVERNIGHT
// THURSDAY shift's carryover (see buildDayEffectivePoolFromRosterEntries /
// generateDutiesForDay's dayEffectivePool: "their own today-dated shift
// always takes priority when one exists" -- ownShift ?? carryover, NEVER
// both). The empirical check above CONFIRMED all 10 "idle" candidates
// were exactly the agents already covering AT587/AT272/AT555/AT533/AT515/
// AT248 via Thursday N8/NT01 carryover -- giving them a brand-new,
// separate Friday shift silently revoked that carryover coverage. That
// was a test-harness methodology bug, not a genuine Stage 9 finding. This
// corrected version excludes anyone with an overnight Thursday shift, to
// isolate TRULY idle (no commitment of any kind touching Friday) capacity.
console.log("\n=== COUNTERFACTUAL #2b (CORRECTED): adding TRULY idle employees (no Friday row, no Thursday-overnight carryover) ===");
const trulyOffCandidates: SwapCandidate[] = offCandidates.filter((c) => {
  const thu = thuShifts.get(c.employeeId);
  return !(thu && OVERNIGHT_CODES.has(thu.shift_code));
});
console.log(`Of the ${offCandidates.length} previously-flagged "idle" candidates, ${trulyOffCandidates.length} are genuinely idle (no Thursday-overnight carryover contaminating the count); ${offCandidates.length - trulyOffCandidates.length} were actually already covering Friday morning via carryover.`);
for (const c of trulyOffCandidates) console.log(`  ${c.name} (${c.employeeId}): legal for [${c.legalFor.join(", ")}]`);

if (trulyOffCandidates.length > 0) {
  const addOverrides2 = new Map<string, string>();
  for (const c of trulyOffCandidates) addOverrides2.set(c.employeeId, c.legalFor.includes("N8") ? "N8" : c.legalFor[0]);
  const addFriGen2 = buildGeneratedShifts(FRI, addOverrides2);
  for (const [empId, code] of addOverrides2) {
    if (!addFriGen2.find((g) => g.employeeId === empId)) addFriGen2.push({ employeeId: empId, dayOfWeek: FRI, shiftCode: code, coversRoles: [] });
  }
  const addFriResult2 = countUnfilled(FRI, addFriGen2, priorDayMapFrom(thuShifts));
  console.log(`\nFriday unfilled after ADDING ${trulyOffCandidates.length} TRULY idle employees: ${addFriResult2.unfilled.length} (baseline was ${baselineFriResult.unfilled.length})`);
  for (const u of addFriResult2.unfilled) console.log("  ", JSON.stringify(u));

  // Also check Saturday carryover effect of this corrected addition.
  const modifiedFriShifts2 = new Map(friShifts);
  for (const [empId, code] of addOverrides2) {
    const t = getShiftTimesAs(code, dateFor(FRI));
    modifiedFriShifts2.set(empId, { ...t, shift_code: code });
  }
  const cfSatGen2 = buildGeneratedShifts(SAT, new Map());
  const cfSatResult2 = countUnfilled(SAT, cfSatGen2, priorDayMapFrom(modifiedFriShifts2));
  console.log(`\nSaturday unfilled after corrected Friday addition (carryover effect): ${cfSatResult2.unfilled.length} (baseline was ${baselineSatResult.unfilled.length})`);
  for (const u of cfSatResult2.unfilled) console.log("  ", JSON.stringify(u));
} else {
  console.log("No genuinely idle candidates remain after excluding Thursday-carryover contamination -- every nominally 'OFF Friday' flexible-pool Gate/Boarding employee is in fact already providing real coverage somewhere in this 24h window.");
}

// === DECISIVE CHECK: is AP04 (the analytically-highest-scoring code per
// stage6_score_trace.ts's hard-coverage math) even LEGAL for ANYONE in the
// flexible pool on Friday? If legalCodesByEmployee never includes AP04 for
// a single employee (due to THEIR OWN prior/next-day rest constraints --
// independent of scoring entirely), it would score 0 picks regardless of
// how high its theoretical coverage is, because it's simply never offered
// as a candidate at all. This decisively separates "AP04 competes and
// loses" from "AP04 is never even in the running."
console.log("\n=== DECISIVE CHECK: is AP04 ever REST-LEGAL for any flexible-pool employee on Friday? ===");
let ap04LegalCount = 0;
let ap03LegalCount = 0;
const ap04LegalEmployees: string[] = [];
for (const emp of EMPLOYEES) {
  if (!isFlexibleGeneralPool(emp)) continue;
  const prior = thuShifts.get(emp.id);
  const next = satShifts.get(emp.id);
  for (const code of ["AP03", "AP04"]) {
    const times = getShiftTimesAs(code, dateFor(FRI));
    let ok = true;
    if (prior) {
      if (restHoursBetween(prior.shift_start, prior.shift_end, times.shift_start) < MIN_REST) ok = false;
    }
    if (ok && next) {
      if (restHoursBetween(times.shift_start, times.shift_end, next.shift_start) < MIN_REST) ok = false;
    }
    if (ok) {
      if (code === "AP04") { ap04LegalCount++; ap04LegalEmployees.push(`${emp.name} (${emp.id}): Thu=${prior?.shift_code ?? "OFF"}, Sat=${next?.shift_code ?? "OFF"}`); }
      if (code === "AP03") ap03LegalCount++;
    }
  }
}
console.log(`AP04 rest-legal for ${ap04LegalCount} flexible-pool employees on Friday.`);
console.log(`AP03 rest-legal for ${ap03LegalCount} flexible-pool employees on Friday.`);
for (const e of ap04LegalEmployees.slice(0, 15)) console.log("  ", e);
