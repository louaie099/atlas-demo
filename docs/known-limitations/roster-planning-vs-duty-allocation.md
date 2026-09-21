# Known limitation: Roster Planning vs. Duty Allocation are not yet separated

**Status: documented requirement, not yet implemented.** Recorded here so it
survives independently of any one conversation or commit, and so the
multi-week Flight Program / Import Flights milestone can proceed without
being blocked on it or accidentally trying to solve it as a side effect.

## The problem, stated precisely

ATLAS currently treats "does this employee work today" and "what operational
duty do they perform today" as the same decision, made in one step, driven
entirely by flight demand:

- Stage 6 (`lib/planning/shift-generation.ts`'s `generateFlexiblePoolShifts`,
  and the analogous logic in `lib/planning/specialized-team-generation.ts`
  for Profiling/Mesure) decides an employee is **rostered at all** only if
  doing so adds marginal coverage value against that day's real flight
  demand.
- When demand is low, this is legitimate FOR COVERAGE PURPOSES — the
  seeded week's 257/257 result proves the joint solver correctly finds the
  minimum sufficient roster for demand — but it also means an employee with
  no demand-driven task that day is left **OFF entirely**, with zero
  rostered hours, rather than rostered-but-idle. In the current seeded
  week this produces real employees genuinely OFF all seven days and
  several working only one day — a workforce-planning outcome, not just a
  coverage one, and RAM Handling does not consider low flight demand
  sufficient grounds for that on its own.

## The distinction that needs to exist, and doesn't yet

- **Roster planning** — WHEN an employee is scheduled to work, and whether
  that fulfills their real working-hours/contractual obligation. This
  should be driven by the employee's own obligation (once confirmed — see
  below), 15h rest, real OFF/rest rules, cross-week continuity, and
  fairness — not by flight demand.
- **Duty allocation** — WHAT operational work a rostered employee performs
  during their scheduled hours, driven by flight demand, qualifications,
  and shift-window compatibility (this is what Stage 9 — `duty-generation.ts`
  / `scoring.ts` — already does, and does correctly).

An employee can legitimately be **WORKING / rostered** with a real, honest
stretch of **no specific flight duty assigned** during part of their shift —
that is available operational capacity, not an OFF day and not a duty to be
invented. ATLAS has no way to represent or produce this outcome today:
Stage 6 only ever rosters a shift when it has demand to justify it.

## What this is explicitly NOT

- **Not** a request to manufacture duties, pad shifts, or roster people with
  nothing real for them to do.
- **Not** solved by raising `config.maximum_average_weekly_working_hours`
  (42h) into a per-employee target. That value is the confirmed AVERAGE
  labor-rule ceiling (see `lib/planning/average-hours.ts` and
  `lib/labor-rules.ts`) — a compliance rule about not exceeding an average
  over a still-unconfirmed reference period, not a target-hours floor every
  employee must be scheduled to hit. Conflating the two would be inventing
  policy exactly the way this codebase's own conventions (see
  `checkin-demand.ts`, `average-hours.ts`) are built to avoid.
- **Not** something to implement now. The real RAM Handling working-hours /
  roster obligation (what determines an employee's rostered-hours target)
  is not yet confirmed. Building an algorithm against a guessed obligation
  would be the same category of mistake the confirmed-vs-prototype
  distinction elsewhere in this codebase exists to prevent.

## What future roster-generation work needs to account for, together

Once the real obligation is confirmed, redesigning roster generation means
jointly satisfying, not trading off one for another:

- the confirmed working-hours/roster obligation (once defined);
- the 15h minimum rest (hard, unchanged);
- real OFF/rest rules;
- qualifications;
- operational demand (still a real input — just no longer the ONLY input
  deciding whether someone is rostered at all);
- shift-template compatibility;
- continuous cross-week planning (see `rotation-context.ts` — already
  exists and should extend, not be replaced);
- fairness/workload distribution across the otherwise-idle population
  (already a known, separate gap — see the delivered Priority-2 audit's
  `youssef-el-amrani` 7-day/63h finding).

This is a genuinely new objective for the joint solver, not a parameter
tweak — expect it to change how `generateFlexiblePoolShifts` scores
candidates, not just its inputs.

## Confirmed so far (RAM Handling / Moses, 2026-09-17)

A heavy-week stress test (152 synthetic flights, week of 2026-09-07) made
this limitation concrete and live: 133 of 201 employees (66%) flagged with
`consecutive_off_violation` (3-7 straight OFF days), and Qatar Airways
duty coverage failed because only 2 of 7 authorized employees were ever
rostered in at all — the other 5 sat OFF the entire week. Real answers
gathered from that:

- **The principle is confirmed, the number is not.** Employees are
  scheduled according to their real working-hours obligation, never
  purely because a day's flight demand happens to justify it — see
  `lib/labor-rules.ts`'s `workingHoursObligationHours` /
  `lib/planning/roster-obligation.ts` (added as scaffolding, currently
  `null`/not-evaluable — nothing reads it yet). The exact target/shape
  (flat weekly hours, minimum shift count, an average over some period,
  something else) is still NOT confirmed. Do not guess it.
- **The 42h reference period is still unconfirmed** — no change from
  above; `working_hours_reference_period_days` stays `null`.
- **Cross-team redeployment is confirmed, in one specific shape.** A
  foreign-company ACE remains a RAM Handling employee. Their company
  operation has priority and creates a hard protected window around the
  real flight (now correctly enforced — see the shipped duty-generation.ts
  fix for the cross-company double-booking bug this exposed). Outside
  that window, if their RAM shift is still active, they are real
  available RAM capacity according to their actual qualifications — not
  "foreign duty or OFF for the day." Transit is the one confirmed
  exception: once clocked in, a Transit agent stays committed to Transit
  for the whole shift, never partially available (unchanged,
  `isTransitTeam`). Do NOT generalize this redeployment behavior to
  Mesure/Profiling yet — not confirmed either way.
- **Team headcounts are placeholders until confirmed individually, not
  collectively.** Gulf Air was corrected from a demo placeholder (6
  people / 2 per flight) to the real number (8 people / 8 per flight —
  see the shipped company-config.ts + employee-generator.ts patch).
  Confirmed detail not yet modeled: Gulf Air's 8 is 7 ACE + 1 leader, and
  the leader coordinates rather than filling a generic Check-in-style
  slot — today's model treats all 8 as interchangeable "Company Team"
  members. Qatar Airways (7/2), Emirates (9/3), Etihad (5/2), Air France
  (5/3), and Mesure (12/4) are all still unconfirmed demo values and
  should be treated with the same suspicion Gulf Air's turned out to
  deserve.
- **Headcount flatness is confirmed only for Gulf Air (flat, 8/flight,
  every flight).** Whether Qatar/Emirates/Etihad/Air France ever scale
  with aircraft type, booking pressure, or day of week is NOT confirmed.
  RAM's own Gate/Boarding/Profiling/Mesure headcount already legitimately
  varies by aircraft class via `ram-staffing-matrix.ts` — that mechanism
  is unrelated and unaffected.
- **Fairness has a confirmed qualitative floor, no confirmed target.**
  The objective is NOT "make everyone's duty count equal" — it's "don't
  repeatedly overuse the same eligible employees while leaving comparable
  eligible employees unused," evaluated over a rolling window across
  weeks, never by forcing equality inside one displayed Monday-Sunday
  week. No confirmed weighting across hours/duty-count/shift-type/
  historical-workload yet — don't invent one.
- **OFF-day rotation shape is NOT uniform across teams by assumption.**
  15h rest / max-2-consecutive-OFF / continuous cross-week planning are
  confirmed and universal. The JR→NT→OFF→OFF fixed cycle is confirmed
  ONLY for Transit/Leaders (Duty Officers' exact rotation is still
  insufficiently confirmed). General T1 is NOT confirmed to use that
  cycle. Foreign-company teams follow their real flight program plus
  compatible RAM shifts, not a blindly-applied fixed cycle. Do not
  generalize any one team's confirmed shape onto another.

The working-HOURS obligation number/shape is still unwired (see
`lib/planning/roster-obligation.ts`'s doc comment for why implementing
against a partially-confirmed principle without a real number would
repeat exactly the mistake this document exists to prevent) — but see the
2026-09-21 update immediately below for what IS now wired.

## Confirmed and implemented (RAM Handling / product owner, 2026-09-21)

Two further, narrower facts were confirmed and are now implemented in
`lib/planning/roster-generation.ts`'s `generateObligationToppedUpShifts`
(see that module's own doc comment for the full mechanism):

- **"5 WORK + 2 OFF, independent of demand" is its own confirmed rule,
  separate from the still-unconfirmed hours number.** A normal flexible
  ACE is now topped up toward `daysOrder.length -
  config.normal_weekly_off_days` worked days EVERY run, regardless of
  whether `working_hours_obligation_hours` is ever configured — this was
  previously a complete no-op while that number stayed `null` (today's
  real-world default), which is exactly the "OFF all week" / "1-2 days
  worked" outcome this document originally flagged as unacceptable. The
  heavy-week stress test's 33-employees-OFF-all-week and
  66%-consecutive-OFF-violation findings (below) are now 0 and ~16%
  respectively under the SAME synthetic 152-flight week — see the
  before/after benchmark the product owner requested, recorded in the
  delivered session report.
- **Consecutive OFF days is a confirmed SOFT preference, never a hard
  constraint.** When there's a real choice of which days to leave OFF,
  the top-up stage prefers to consolidate the 2 OFF days into one block
  (e.g. Sat/Sun) — but a legal SEPARATED pattern (e.g. Tue + Fri) remains
  fully valid whenever consecutive isn't achievable without a real
  staffing/rest tradeoff. See `lib/planning/validation.ts`'s
  `separated_off_days` PlanIssue (a non-blocking recommendation, distinct
  from the unrelated, unchanged, hard `consecutive_off_violation` ceiling)
  and `lib/planning/consecutive-off.ts`'s `checkOffDaysSeparated`.

Still NOT confirmed, and NOT guessed: the actual weekly-hours obligation
number/shape (`working_hours_obligation_hours`) and its reference period
(`working_hours_obligation_reference_period_days`) — both remain `null`
until management provides a real value; the day-count top-up above does
not depend on either.

## Fairness-rotation bug fixed (RAM Handling / product owner, 2026-09-21)

Separately from the above, a real correctness bug was found live: for
Profiling, Mesure, and every foreign-company team (confirmed on Air
France — a 5-person team with a confirmed 3/flight headcount need), the
same first N employees in `specialized-team-generation.ts`'s fixed pool
order were assigned EVERY duty, every day, every week, while the
remaining team members sat OFF permanently (Tarik/Widad Idrissi never
worked a single day while Fadwa/Khalid/Marouane Idrissi took every Air
France duty). This was not a business-rule ambiguity — "spread work
fairly across the team" is a stated ATLAS design goal, not an
unconfirmed number — so it's fixed directly: `assignPoolToWindow`/
`assignPoolToWindowWithRoles` now receive their pool pre-sorted by
ascending cumulative assigned hours THIS WINDOW (`sortByLeastUsedFirst`),
so an idle team member is always preferred over one who's already
covered several duties this week. See `tests/specialized-team-fairness.test.ts`.

**Known remaining limitation**: this fairness ledger resets every
generation run — it only spreads work WITHIN one displayed week, not
across weeks. An employee who worked heavily last week gets no
advantage-reset this week; nothing yet tracks cumulative hours across
week boundaries the way `rotation-context.ts` tracks one day of rest
continuity. A genuine cross-week fairness ledger is a larger addition
(likely alongside whatever eventually implements the confirmed
working-hours obligation, which also needs a real hours-history), not
implemented here — flagged, not silently left as if solved.

## T1 Check-in ZONE model — LIVE (RAM Handling / product owner, 2026-09-21)

Confirmed separately, from a real CMN Check-in/Boarding agent: RAM does
NOT staff Terminal 1 Check-in per flight. RAM operates shared Check-in
zones; an agent works a zone/counter range and processes passengers from
whichever flights currently have Check-in open there. The old per-flight
`checkin-demand.ts`/`weekly-requirements.ts` model (one requirement row
per flight, agents effectively "belonging" to one flight) overstates
demand and misrepresents the real operation. The confirmed real pipeline
is:

> RAM flight program → which T1 zone each flight uses → which flights
> currently have Check-in open → combined workload in that zone →
> required T1 Check-in workforce → agents assigned to the zone/counters.

Update (same day, later cutover pass): the product owner reviewed the
standalone engine described below and asked for it to actually replace
the old per-flight path end to end — "a backend engine nobody calls
doesn't satisfy 'implement this.'" That cutover is now done and is what
actually drives the displayed Weekly Plan, not the old per-flight
Check-in requirement. See the new "Confirmed and LIVE" section below for
exactly what changed and what remains genuinely open.

**Confirmed and implemented this session:**
- The six-zone taxonomy (`lib/checkin-zones.ts`): Upper floor Main
  Check-in (30–76), Upper floor Business Check-in (76–86), Floor 0
  Italy/Spain (1–19), Floor 0 Domestic (20–26), Staff Check-in (26–30),
  Oversized Baggage (one dedicated function). Business/Staff/Oversized
  exist as real, addressable zones but get NO invented automatic demand
  formula (`demandMode: "manual"`) — per the explicit instruction not to
  fabricate a coefficient "for completeness."
- Destination-based zone routing (`classifyCheckinZone`) — Italy/Spain
  routes from destination/IATA data only, never flight number. This is a
  genuinely SEPARATE classification axis from
  `classifyDestinationOperationally`'s RAM operational category (Spain is
  "Europe/Schengen" for Gate/Boarding/Profiling purposes and
  "Italy/Spain zone" for Check-in purposes — two unrelated facts about
  the same destination, deliberately not merged).
- Zone-level, time-bucketed AGGREGATE demand (`lib/planning/checkin-zone-
  demand.ts`, `lib/planning/zone-demand-aggregation.ts`) — the shared
  per-zone `base_agents` is applied ONCE per 30-minute bucket that has any
  active flight, with each flight contributing only its own incremental
  complexity delta (destination category / Dreamliner / booking pressure)
  on top, floored by a per-active-flight minimum. This reuses
  `checkin-demand.ts`'s existing prototype coefficients (still entirely
  `unconfirmed_prototype`-grade — none of these numbers are real RAM
  policy) rather than inventing a new "real-sounding" formula.
- DEFAULT idle-time T1 Check-in PLACEMENT
  (`lib/planning/checkin-zone-placement.ts`) — for a rostered General T1
  ACE (or any other ACE population `isRedeploymentAllowed` already
  permits), after existing higher-priority duties are placed, their
  remaining free shift interval(s) default to Check-in zone coverage,
  split around existing commitments so the timeline never overlaps.
  Reuses `isTransitTeam`/`isFixedPlanningTeam`/`isProfilingOrMesureAssigned`/
  `isRedeploymentAllowed` exactly, never a parallel eligibility engine.
  Explicitly kept as a SEPARATE concept from zone DEMAND — a placement
  duty's existence never inflates a zone's `required_headcount`; the two
  are computed by entirely independent functions (`tests/checkin-zone-
  placement.test.ts`'s "REQUIRED-STAYS-AT-DEMAND invariant" test proves
  this directly: placement always places every eligible idle employee
  regardless of what any zone's own demand happens to require).
- Persistence schema for the parallel zone-requirement/zone-assignment
  model (`supabase/migrations/0015_checkin_zones.sql`,
  `ZoneCheckinRequirement`/`ZoneCheckinAssignment` in `lib/types.ts`) —
  new tables alongside the existing flight-anchored
  `staffing_requirements`/`assignments`, with a real join table
  (`checkin_zone_requirement_contributing_flights`) for the
  zone-to-contributing-flights relationship rather than a JSON blob.

**Confirmed and LIVE (cutover pass, same day):**
- `lib/planning/weekly-requirements.ts` no longer generates the old
  per-flight Check-in `StaffingRequirement` row for RAM/atlas_managed
  flights (`isCheckinApplicable`/`computeGeneralizedCheckinRequirement`
  are no longer called from the live requirement-generation path). Every
  other role's requirement row (Gate/Boarding/Profiling/Mesure) for the
  same flight is untouched. `checkin-demand.ts` and its exports still
  exist in the codebase — other code/tests may still reference
  `CheckinDemandPolicy` types — but nothing on the live path invokes it
  any more.
- `lib/planning/generate-draft-plan.ts` now calls
  `aggregateAllZonesDailyDemand`/`zoneDemandClusters` against the week's
  RAM flights to compute each day's zone requirements BEFORE any
  placement runs, and calls `computeDefaultCheckinZonePlacement` for
  eligible rostered employees after Gate/Boarding/Profiling/Mesure/
  foreign-company duties are placed for the day, reusing
  `duty-generation.ts`'s exact busy-windows shape. `DraftWeeklyPlan` now
  carries `zoneRequirementsByDay`/`zoneDutiesByDay` alongside the
  existing per-flight structures.
- `lib/planning/weekly-plan-service.ts`'s `buildDraftPlanBundle` builds
  `ZoneCheckinRequirement`/`ZoneCheckinAssignment` rows with deterministic
  IDs and persists them into the new `checkin_zone_requirements`/
  `checkin_zone_assignments`/`checkin_zone_requirement_contributing_flights`
  tables, following the same Draft/config_snapshot persistence pattern as
  `staffing_requirements`/`assignments`. `regenerateDraftPlan` deletes and
  rebuilds these rows by `plan_id` the same way it already does for the
  flight-anchored tables. `loadPersistedPlanView` reads all three tables
  back and reassembles `ZoneCheckinRequirement[]` with
  `contributingFlightIds` for the UI.
- Flight Coverage now has a dedicated zone-coverage section
  (`components/zone-coverage-card.tsx`) showing each zone's window,
  required/assigned/gap, and a drill-down of contributing flights sourced
  from the join table — kept as a sibling section rather than forced into
  `flight-coverage-card.tsx`'s per-flight layout. `agent-day-detail.tsx`
  renders a zone duty as "T1 Main Check-in · counters 30–76 ·
  HH:MM–HH:MM" using the assignment's OWN `window_start`/`window_end`
  (not the parent requirement's, potentially wider, window) so a
  narrower individual placement never gets misrepresented as the whole
  demand window; every other role's rendering is unchanged.
  `planning-summary-bar.tsx`/`summary-drilldown-sheet.tsx` add
  "T1 Check-in zones covered"/"T1 Check-in zone gaps" as their OWN
  counted bucket, with tooltip copy explicit that this is a different
  kind of number from "Requirements covered"/"Staffing gaps" (one zone
  requirement can represent several flights' combined workload, not one
  flight+role slot).
- Find Agent has a zone-gap variant: new routes
  `/api/checkin-zone-candidates/[zoneRequirementId]` and
  `/api/checkin-zone-assign` (`components/zone-find-agent-sheet.tsx`),
  reusing `scoreCandidates`/`computeBusyWindowsForDay`/the existing
  day-effective-pool logic rather than a parallel eligibility engine.
  Clicking a zone gap in the Staffing Gaps drill-down opens this variant;
  a successful assignment persists as `human_modified` and updates the
  zone's coverage, following the same audit convention as `/api/assign`.
- End-to-end coverage against the real seeded week
  (`tests/zone-plan-integration.test.ts`) proves the wiring itself, not
  just the individual unit-tested modules: no per-flight Check-in row is
  generated any more, `required_headcount` is architecturally independent
  of how many employees got placed (computed before placement runs at
  all), only the three ordinary zones ever receive default placement,
  no employee is ever double-booked across two zone duties on the same
  day, and every persisted zone assignment references a real zone
  requirement row (FK integrity).
- A before/after benchmark on the same 152-flight heavy week (via a git
  worktree at the pre-cutover commit) confirms every
  Gate/Boarding/Profiling/Mesure/Company-Team duty count, required count,
  staffing gap, and hard violation (rest/consecutive-OFF) is
  byte-identical before and after the cutover. One genuine, expected
  side effect was found and is reported here rather than hidden: removing
  Check-in from Stage 6's aggregate demand shifted the flexible pool's own
  working-day distribution slightly (more people land on the
  demand-independent "5 WORK + 2 OFF" top-up rather than a
  demand-driven extra day, since that demand no longer includes
  Check-in's contribution), which also reduced `separated_off_days`
  warnings and slightly lowered mean scheduled hours. This is a real,
  legitimate downstream consequence of correcting the demand model, not a
  bug — but it is a visible change in the roster shape and should be
  reviewed by RAM Handling like any other planning-quality shift.
- Observed characteristic of the current placement heuristic (not a
  bug, but worth flagging): `pickDefaultZone` always assigns a free
  interval to whichever ordinary zone has the highest concurrent demand
  at that interval's midpoint. On the heavy-week benchmark this
  concentrated the large majority of placement duties into
  `t1_main_checkin` (401 of 406) and a handful into `t1_italy_spain` (5),
  with zero landing in `t1_domestic` despite `t1_domestic` having 14
  non-zero-required requirement rows of its own. The REQUIRED headcount
  per zone is unaffected (it is computed independently, before
  placement), but actual staffing coverage in `t1_domestic` on that week
  relies entirely on Find Agent / renfort rather than default placement.
  A future improvement could balance placement across zones with unmet
  demand rather than always picking the single busiest one.

**Still genuinely open (not part of this cutover, flagged not
hand-waved):**
- Zone-specific qualifications (e.g. "Main Check-in qualified" vs
  "Italy/Spain qualified") are NOT modeled — any Check-in-qualified ACE is
  eligible for any ordinary zone today, per the explicit instruction not
  to invent this distinction; `Employee` carries no field for it yet
  (a future optional zone-qualification list is the intended extension
  point, left unused/empty rather than hardcoded absent everywhere).
- The exact counter boundaries at 76 (Main/Business) and 26
  (Domestic/Staff) remain literal, unresolved overlaps — see
  `lib/checkin-zones.ts`'s `overlapsWith` field — pending a real decision
  from RAM Handling, never silently picked.
- There is no `assignment_modifications`-equivalent audit table for zone
  assignment edits yet — a zone Find-Agent assignment is persisted and
  marked `human_modified` on the assignment row itself, but a dedicated
  history/audit trail (mirroring whatever exists for flight+role
  assignment edits) was not built this session.

## Sequencing

1. Multi-week Flight Program / Import Flights — done.
2. Heavy-week stress test against the real planner — done; this is what
   surfaced the 66%-of-workforce consecutive-OFF finding and the Qatar
   Airways coverage failure that made this document concrete instead of
   theoretical.
3. Two isolated bug fixes the stress test exposed, unrelated to this
   redesign — done: the foreign-company protected-window double-booking
   (duty-generation.ts), and the `isStale` false-positive from unordered
   Postgres row fetches (`hashPlanInputs`).
4. Confirm real per-team facts as they surface — in progress. Gulf Air's
   real headcount (8, composition 7+1 leader) is confirmed; see above for
   what's still open per team.
5. Confirm the real RAM Handling working-hours/roster obligation (the
   number/shape, not just the principle) with management — still open,
   blocks step 6 entirely.
6. Redesign roster generation (Stage 6) against the confirmed obligation,
   jointly with everything listed above — PARTIALLY DONE (2026-09-21):
   the "5 WORK + 2 OFF, independent of demand" day-count rule and the
   consecutive-OFF soft preference are implemented and always-on for the
   general flexible ACE pool (see the confirmed-and-implemented section
   above). The weekly-HOURS obligation top-up remains fully scaffolded
   but inert (`working_hours_obligation_hours` stays `null`) until
   management confirms the real number/shape — nothing here guesses it.
