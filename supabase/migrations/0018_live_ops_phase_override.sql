-- Additive migration — run AFTER 0001 through 0017.
-- Backs the new flight operational LIFECYCLE phase (see lib/flight-phase.ts):
-- a purely-display, passenger-facing concept, independent of the Check-in
-- staffing demand model (lib/planning/checkin-demand.ts) and the RAM
-- Gate/Boarding/Profiling staffing window (lib/planning/requirement-window.ts)
-- — neither of those is touched by this migration or by the feature it backs.
--
-- `operational_phase_override` is the ONE new column: nullable, no
-- default. NULL means "follow the clock" — the phase is auto-derived (see
-- lib/flight-phase.ts's deriveAutoFlightPhase) from the flight's effective
-- departure time (lib/flight-operations.ts's effectiveDeparture) against
-- the product owner's own stated thresholds: check-in opens T-4h, closes
-- T-1h, boarding starts T-45min, boarding closes T-15min, departed once
-- departure time passes. A non-null value is a Duty Officer's manual
-- override of that computed phase (e.g. boarding started early, or a
-- departure already happened but the operational time hasn't been
-- updated yet) — set only by the Live Operations Edit Flight drawer's
-- operational PATCH route (app/api/flights/[id]/operational/route.ts),
-- same as actual_departure.
--
-- The CHECK constraint keeps the stored value aligned with the FlightPhase
-- union in lib/flight-phase.ts — any drift between the two must be caught
-- here, not discovered at read time.
--
-- No default, no backfill, no NOT NULL, no touching any existing column.

alter table flights add column operational_phase_override text
  check (operational_phase_override is null or operational_phase_override in (
    'pre_checkin', 'checkin_open', 'checkin_closed', 'boarding', 'boarding_closing', 'departed'
  ));
