import { Flight, StaffingRequirement } from "../types";
import { getRequirementWindow } from "./requirement-window";
import { CheckinDemandPolicy, DEFAULT_CHECKIN_DEMAND_POLICY } from "./checkin-demand";

const BUCKET_MINUTES = 30;
const BUCKETS_PER_DAY = (24 * 60) / BUCKET_MINUTES;

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTime(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

export interface DemandBucket {
  start: string; // "HH:mm"
  end: string;
  demandByRole: Record<string, number>;
}

export interface DailyDemand {
  dayOfWeek: string;
  buckets: DemandBucket[];
}

/**
 * The "demand over time" concept from the planning brief: for a given
 * day, at fixed 30-minute granularity, how many people are required
 * SIMULTANEOUSLY for each qualification — accounting for flights whose
 * operational windows overlap, not flight-by-flight in isolation. This
 * is what should drive shift selection (Stage 6), rather than assigning
 * shifts to cover one flight at a time and hoping they add up correctly.
 *
 * Only requirements with needs_configuration: false are counted — an
 * unconfigured requirement has no valid headcount to add to demand; it's
 * surfaced separately by the validation stage instead of silently
 * treated as zero (which would understate demand) or guessed (which
 * would fabricate it).
 *
 * Does not attempt sub-30-minute precision or non-flight demand (e.g.
 * baseline Check-in/Weight-Control staffing independent of any specific
 * flight) — see the report's "what remains simplified" section.
 */
export function aggregateDailyDemand(
  dayOfWeek: string,
  flights: Flight[],
  requirements: StaffingRequirement[],
  checkinPolicy: CheckinDemandPolicy = DEFAULT_CHECKIN_DEMAND_POLICY
): DailyDemand {
  const buckets: DemandBucket[] = Array.from({ length: BUCKETS_PER_DAY }, (_, i) => ({
    start: minutesToTime(i * BUCKET_MINUTES),
    end: minutesToTime((i + 1) * BUCKET_MINUTES),
    demandByRole: {},
  }));

  const dayFlights = flights.filter((f) => f.day_of_week === dayOfWeek);
  const dayFlightIds = new Set(dayFlights.map((f) => f.id));
  const dayRequirements = requirements.filter((r) => dayFlightIds.has(r.flight_id) && !r.needs_configuration);

  for (const requirement of dayRequirements) {
    const flight = dayFlights.find((f) => f.id === requirement.flight_id)!;
    const window = getRequirementWindow(requirement, flight, checkinPolicy);
    const startMin = timeToMinutes(window.start);
    const endMin = timeToMinutes(window.end);

    for (let i = 0; i < BUCKETS_PER_DAY; i++) {
      const bucketStart = i * BUCKET_MINUTES;
      const bucketEnd = bucketStart + BUCKET_MINUTES;
      const overlaps = startMin < bucketEnd && bucketStart < endMin;
      if (!overlaps) continue;

      buckets[i].demandByRole[requirement.role] = (buckets[i].demandByRole[requirement.role] ?? 0) + requirement.total_requirement;
    }
  }

  return { dayOfWeek, buckets };
}

/**
 * The peak simultaneous demand for one role across a day — e.g. "at most,
 * how many Boarding-qualified people does Wednesday need at once." This
 * is what shift generation (Stage 6) actually needs, not the full
 * bucket-by-bucket detail.
 */
export function peakDemandForRole(dailyDemand: DailyDemand, role: string): number {
  return Math.max(0, ...dailyDemand.buckets.map((b) => b.demandByRole[role] ?? 0));
}

/**
 * The overall time span during which a role has any demand at all that
 * day. Returns null if there's no demand for that role that day.
 *
 * NOT what shift generation should feed to shift-code selection when a
 * role's demand is spread across the day in separate clusters (e.g. an
 * early-morning departure and a separate evening one, with a long
 * demand-free gap between) — collapsing to first-active-bucket through
 * last-active-bucket would produce a single all-day span no real shift
 * code can cover, understating coverage entirely for that role. Kept for
 * callers that genuinely want the single overall span (e.g. reporting);
 * shift generation uses demandClustersForRole below instead.
 */
export function demandWindowForRole(dailyDemand: DailyDemand, role: string): { start: string; end: string } | null {
  const activeBuckets = dailyDemand.buckets.filter((b) => (b.demandByRole[role] ?? 0) > 0);
  if (activeBuckets.length === 0) return null;
  return { start: activeBuckets[0].start, end: activeBuckets[activeBuckets.length - 1].end };
}

export interface DemandCluster {
  start: string;
  end: string;
  peak: number; // max simultaneous demand within this cluster only
}

/**
 * Splits a role's demand for the day into separate CONTIGUOUS clusters —
 * maximal runs of consecutive 30-min buckets with nonzero demand for that
 * role — rather than one span covering the whole day. This is what shift
 * generation (Stage 6) actually needs: real airport demand for a role is
 * routinely bursty (a handful of early-morning departures, a gap, then an
 * evening bank), and a single merged window across a gap like that would
 * force shift-code selection to try to cover a span no real shift is long
 * enough for, silently producing zero coverage for the whole role instead
 * of the several separate, individually-coverable windows that actually
 * exist. Each cluster is later covered independently, so different
 * employees can be selected for the morning bank and the evening bank
 * rather than requiring one person to somehow span both.
 *
 * Deliberately simple and bounded (one linear pass over the day's fixed
 * 48 buckets) — not a general interval-optimization; a bucket with zero
 * demand always ends the current cluster, however small the gap.
 */
export function demandClustersForRole(dailyDemand: DailyDemand, role: string): DemandCluster[] {
  const clusters: DemandCluster[] = [];
  let currentStart: string | null = null;
  let currentEnd: string | null = null;
  let currentPeak = 0;

  const flush = () => {
    if (currentStart !== null && currentEnd !== null) {
      clusters.push({ start: currentStart, end: currentEnd, peak: currentPeak });
    }
    currentStart = null;
    currentEnd = null;
    currentPeak = 0;
  };

  for (const bucket of dailyDemand.buckets) {
    const demand = bucket.demandByRole[role] ?? 0;
    if (demand > 0) {
      if (currentStart === null) currentStart = bucket.start;
      currentEnd = bucket.end;
      currentPeak = Math.max(currentPeak, demand);
    } else {
      flush();
    }
  }
  flush();

  return clusters;
}
