import { Flight } from "../types";
import { CheckinZoneId, CHECKIN_ZONE_IDS } from "../checkin-zones";
import {
  ZoneCheckinDemandPolicy,
  DEFAULT_ZONE_CHECKIN_DEMAND_POLICY,
  getFlightCheckinWindow,
  checkinIncrementForFlight,
  zoneBaseAgents,
  zoneMinimumPerActiveFlight,
} from "./checkin-zone-demand";

const BUCKET_MINUTES = 30;
const BUCKETS_PER_DAY = (24 * 60) / BUCKET_MINUTES;

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function minutesToTime(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

/**
 * One 30-minute bucket's demand for ONE zone — the composite key this
 * whole module is keyed by is (zone, time), reusing
 * lib/planning/demand-aggregation.ts's exact bucket shape/granularity but
 * with `zone` as a first-class dimension instead of assuming a single
 * demand series per role string. `contributingFlightIds` is what powers
 * the required "drill down from a zone into its contributing flights" UI
 * — kept as a real list here (not reconstructed later from a join query)
 * so the in-memory aggregation and the persisted
 * checkin_zone_requirement_contributing_flights join table (see the
 * migration) both trace back to the same computed set.
 */
export interface ZoneDemandBucket {
  start: string;
  end: string;
  required: number;
  contributingFlightIds: string[];
}

export interface ZoneDailyDemand {
  dayOfWeek: string;
  zone: CheckinZoneId;
  buckets: ZoneDemandBucket[];
}

/**
 * Stage 1 of the zone pipeline's demand step: for ONE zone, ONE day,
 * combines every atlas_managed flight classified into that zone
 * (classifyCheckinZone) whose Check-in window overlaps a bucket into that
 * bucket's AGGREGATE required headcount — the shared `base_agents` applied
 * ONCE per bucket that has any active flight, plus every active flight's
 * own incremental complexity delta (checkinIncrementForFlight), floored so
 * a bucket with N active flights never reports fewer than
 * `minimum_agents_per_active_flight * N` (a zone actually running N
 * simultaneous flights needs at least enough hands to process all of
 * them, even before any complexity delta). This is the "combined workload
 * in that zone" step of the product owner's pipeline description — never
 * N independent per-flight totals summed.
 */
export function aggregateZoneDailyDemand(
  dayOfWeek: string,
  zone: CheckinZoneId,
  flights: Flight[],
  policy: ZoneCheckinDemandPolicy = DEFAULT_ZONE_CHECKIN_DEMAND_POLICY
): ZoneDailyDemand {
  const buckets: ZoneDemandBucket[] = Array.from({ length: BUCKETS_PER_DAY }, (_, i) => ({
    start: minutesToTime(i * BUCKET_MINUTES),
    end: minutesToTime((i + 1) * BUCKET_MINUTES),
    required: 0,
    contributingFlightIds: [],
  }));

  const dayFlights = flights.filter((f) => f.day_of_week === dayOfWeek);
  const base = zoneBaseAgents(zone, policy);
  const perFlightFloor = zoneMinimumPerActiveFlight(zone, policy);

  // Per-bucket accumulation: increment sum + active flight count, so the
  // base is applied exactly once and the per-active-flight floor is
  // evaluated against the real concurrent count, not per flight in
  // isolation.
  const incrementSumByBucket = Array.from({ length: BUCKETS_PER_DAY }, () => 0);
  const activeCountByBucket = Array.from({ length: BUCKETS_PER_DAY }, () => 0);

  for (const flight of dayFlights) {
    const contribution = checkinIncrementForFlight(flight, policy);
    if (!contribution || contribution.zone !== zone) continue;

    const window = getFlightCheckinWindow(flight, policy);
    const startMin = timeToMinutes(window.start);
    const endMin = timeToMinutes(window.end);

    for (let i = 0; i < BUCKETS_PER_DAY; i++) {
      const bucketStart = i * BUCKET_MINUTES;
      const bucketEnd = bucketStart + BUCKET_MINUTES;
      if (!(startMin < bucketEnd && bucketStart < endMin)) continue;

      incrementSumByBucket[i] += contribution.increment;
      activeCountByBucket[i] += 1;
      buckets[i].contributingFlightIds.push(flight.id);
    }
  }

  for (let i = 0; i < BUCKETS_PER_DAY; i++) {
    if (activeCountByBucket[i] === 0) continue;
    const floor = perFlightFloor * activeCountByBucket[i];
    buckets[i].required = Math.max(floor, base + incrementSumByBucket[i]);
  }

  return { dayOfWeek, zone, buckets };
}

/** Every automatic zone's daily demand for one day, in one call — what the plan generator actually needs (one entry per CHECKIN_ZONE_IDS with demandMode "automatic"; a "manual" zone's own aggregateZoneDailyDemand simply returns all-zero buckets, since checkinIncrementForFlight never resolves a flight into it). */
export function aggregateAllZonesDailyDemand(
  dayOfWeek: string,
  flights: Flight[],
  policy: ZoneCheckinDemandPolicy = DEFAULT_ZONE_CHECKIN_DEMAND_POLICY
): Record<CheckinZoneId, ZoneDailyDemand> {
  const result = {} as Record<CheckinZoneId, ZoneDailyDemand>;
  for (const zone of CHECKIN_ZONE_IDS) {
    result[zone] = aggregateZoneDailyDemand(dayOfWeek, zone, flights, policy);
  }
  return result;
}

/**
 * STAGE-6 HEURISTIC BIAS INPUT (2026-09-23, product owner's point 9): a
 * per-day AGGREGATE T1 demand-across-ALL-zones profile, computed from the
 * flight schedule ALONE — independent of the roster, exactly like the rest
 * of this module — so `roster-generation.ts`'s flexible-pool shift-code
 * selection can be told "this is roughly when T1 demand peaks today" and
 * weight an otherwise-equal choice toward a shift code that actually
 * covers it. This is DELIBERATELY a coarse summary (the bucket with the
 * highest SUMMED required headcount across every automatic zone, ties
 * broken toward the earlier bucket), never itself a claim about which
 * zone or how many agents — see roster-generation.ts's own doc comment on
 * `computeEmployeeDayCountTopUp`'s new `t1PeakDemandMinuteByDay` parameter
 * for exactly how (and how little) this changes shift selection: it is a
 * heuristic bias between otherwise-equal legal candidates, never an
 * override of a hard labor-rule constraint, and a genuine unavoidable
 * shortage can and does still surface (per the owner: "do not hide
 * shortages by capping numbers or manipulating the UI").
 */
export function peakAggregateT1DemandMinuteForDay(
  dayOfWeek: string,
  flights: Flight[],
  policy: ZoneCheckinDemandPolicy = DEFAULT_ZONE_CHECKIN_DEMAND_POLICY
): number | null {
  const totals = aggregateT1DemandProfileForDay(dayOfWeek, flights, policy);
  if (totals.length === 0) return null;

  let bestIndex = -1;
  let bestTotal = 0;
  for (let i = 0; i < totals.length; i++) {
    if (totals[i] > bestTotal) {
      bestTotal = totals[i];
      bestIndex = i;
    }
  }
  if (bestIndex === -1) return null; // no demand at all this day -- nothing to bias toward
  return bestIndex * BUCKET_MINUTES;
}

/**
 * STAGE-6 PRIMARY-PASS BIAS INPUT (2026-09-23 follow-up): the FULL
 * per-30-min-bucket profile behind `peakAggregateT1DemandMinuteForDay`
 * above, kept instead of collapsed to a single peak instant. Computed the
 * exact same way (summed required headcount across every zone in
 * CHECKIN_ZONE_IDS, from the flight schedule alone — no roster dependency)
 * — this function and `peakAggregateT1DemandMinuteForDay` now share this
 * one computation rather than duplicating it.
 *
 * WHY A FULL PROFILE, NOT JUST THE PEAK: the existing peak-minute bias
 * (`computeEmployeeDayCountTopUp`'s `t1PeakDemandMinuteByDay`) only ever
 * reaches the SECONDARY obligation top-up pass, which rarely triggers once
 * an employee already has 5 working days from the PRIMARY pass
 * (`generateFlexiblePoolShifts`, Stage 6's own greedy set-cover chooser).
 * That primary pass needs the full per-bucket shape — not one instant — to
 * weight EVERY candidate shift code by how much of the day's T1 demand
 * curve it would actually sit across (see shift-generation.ts's own doc
 * comment on `t1DemandByBucket` for exactly how this is used: an added,
 * WEIGHTED preference among already-legal candidates, never a hard
 * constraint, and never able to outrank a candidate that covers strictly
 * more real per-flight Gate/Boarding/Profiling/Mesure demand).
 */
export function aggregateT1DemandProfileForDay(
  dayOfWeek: string,
  flights: Flight[],
  policy: ZoneCheckinDemandPolicy = DEFAULT_ZONE_CHECKIN_DEMAND_POLICY
): number[] {
  const byZone = Array.from(new Set(CHECKIN_ZONE_IDS)).map((zone) => aggregateZoneDailyDemand(dayOfWeek, zone, flights, policy));
  if (byZone.length === 0) return [];

  const bucketCount = byZone[0].buckets.length;
  const totals: number[] = new Array(bucketCount).fill(0);
  for (let i = 0; i < bucketCount; i++) {
    totals[i] = byZone.reduce((sum, daily) => sum + daily.buckets[i].required, 0);
  }
  return totals;
}

export interface ZoneDemandCluster {
  start: string;
  end: string;
  peak: number;
  contributingFlightIds: string[];
}

/**
 * Same "contiguous run of nonzero-demand buckets" shape as
 * demand-aggregation.ts's demandClustersForRole, applied to one zone's
 * ZoneDailyDemand instead of a role's DemandBucket series — this is what
 * the eventual zone-requirement rows (one per cluster, per zone, per day)
 * are built from, and what a bucket-grained shift/coverage story
 * (Flight Coverage's zone drill-down) reduces its granularity to for
 * display when a whole cluster is one contiguous operational window.
 */
export function zoneDemandClusters(dailyDemand: ZoneDailyDemand): ZoneDemandCluster[] {
  const clusters: ZoneDemandCluster[] = [];
  let start: string | null = null;
  let end: string | null = null;
  let peak = 0;
  let flightIds = new Set<string>();

  const flush = () => {
    if (start !== null && end !== null) {
      clusters.push({ start, end, peak, contributingFlightIds: Array.from(flightIds) });
    }
    start = null;
    end = null;
    peak = 0;
    flightIds = new Set();
  };

  for (const bucket of dailyDemand.buckets) {
    if (bucket.required > 0) {
      if (start === null) start = bucket.start;
      end = bucket.end;
      peak = Math.max(peak, bucket.required);
      for (const id of bucket.contributingFlightIds) flightIds.add(id);
    } else {
      flush();
    }
  }
  flush();

  return clusters;
}
