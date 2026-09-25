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

## Foreign-company roster/redeployment/double-booking audit fixed (RAM Handling / product owner, 2026-09-22)

A completed audit (reproduced against the live code, all three cited line
ranges confirmed unchanged) found three related defects affecting EVERY
configured foreign company generically (not specific to any one airline
used in the reproduced examples). All three are now fixed:

1. **Foreign-company employees now get a normal RAM weekly roster.**
   `specialized-team-generation.ts`'s `generateForeignCompanyShifts`
   previously left a foreign-company employee with NO roster entry at all
   (reading as OFF downstream) on any day their own company had no flight,
   or on a flight day if they weren't one of the N selected — even though
   they remain RAM Handling employees. Fixed by reusing the SAME
   "5 WORK + 2 OFF, independent of demand" day-count/consecutive-OFF-
   preference logic `roster-generation.ts`'s `generateObligationToppedUpShifts`
   already established for the flexible General T1 pool: that per-employee
   core was factored out into a new shared function,
   `computeEmployeeDayCountTopUp` (in `roster-generation.ts`), so the two
   populations' soft consecutive-OFF preference can never drift apart. A
   day this top-up adds is a real, honest RAM-compatible working day (the
   shortest-legal-catalog-code rule, exactly as the flexible pool's own
   top-up picks) — never a fabricated company duty, and never folded into
   `isFlexibleGeneralPool` (foreign-company employees remain a distinct
   population, still excluded from generic Boarding/Gate/Check-in demand
   matching outside their real company role). `generateForeignCompanyShifts`
   takes an optional `config` parameter; without it, the top-up is a
   strict no-op (backward compatible with every existing caller/test).
   `generate-draft-plan.ts` now passes the real `Config`.
2. **Cross-team redeployment now defaults to TRUE for every configured
   foreign company.** `teams.ts`'s `TEAM_REDEPLOYMENT_POLICY` table was
   empty for every company, so `isRedeploymentAllowed` always returned
   `false`, silently disabling the "return remaining shift time to RAM T1
   capacity" mechanism in `checkin-zone-placement.ts` (which was already
   built correctly). `isRedeploymentAllowed` now defaults to `true` for
   every entry in `CONFIGURED_COMPANIES`, generically — never a per-
   airline branch — while an explicit entry in `TEAM_REDEPLOYMENT_POLICY`
   (still empty today) can still override a specific company if a future
   exception is confirmed. Transit remains the one hard, non-configurable
   exception (`isTransitTeam` short-circuits before any table/company
   lookup, unconditionally). Mesure/Profiling are NOT foreign companies
   (not in `CONFIGURED_COMPANIES`) and are therefore untouched by this
   change — their redeployment status remains the separate, still
   genuinely unconfirmed question it always was; nothing here decides it
   either way. Fixed/fixed-cycle teams (Leaders/Duty Officers/Caisse-BCB)
   are likewise never foreign companies, so the new default never reaches
   them.
   - A SEPARATE, narrower policy dimension — whether a team's generated
     shift should PREFER the longest compatible catalog code (deliberately
     manufacturing MORE redeployment slack than the minimal covering shift
     naturally leaves) — was split out into its own function,
     `isShiftExtensionPreferred` (still governed by the now-otherwise-
     unused `TEAM_REDEPLOYMENT_POLICY` table, so still `false` for every
     team today). This was investigated and deliberately NOT defaulted to
     `true` alongside `isRedeploymentAllowed`: doing so caused real
     rest-feasibility shortfalls in a production-shaped regression test
     (a deliberately-lengthened shift on one day left insufficient rest
     before the next day's real commitment) — an unconfirmed, unintended
     side effect, not a business rule this audit confirmed. The confirmed
     principle (idle time on an ALREADY-selected, minimally-sized covering
     shift becomes real RAM capacity) does not require ATLAS to
     intentionally lengthen anyone's shift, and doesn't depend on this
     flag to have effect.
3. **The exact double-booking scenario from the audit is now rejected.**
   `duty-generation.ts`'s `generateDutiesForDay` clustering pass (the
   union-find overlap grouping) and its `scoreCandidates` call both used
   to treat a `company_config` requirement's conflict window as
   `getRequirementWindow`'s narrow generic default (`departure-45min` to
   `departure-15min`, since a foreign flight doesn't set
   `boarding_window_start/end`) rather than the WIDE real protected window
   (`computeForeignCompanyProtectedWindow`, ~4h30 before departure) that
   `computeBusyWindowsForDay` already correctly used for busy-blocking.
   Fixed by computing a `conflictWindows[i]` array (protected window for
   `company_config` sources, the requirement's own window for everything
   else) and using it for BOTH the clustering overlap decision AND the
   `scoreCandidates` call that actually decides eligibility against
   `busyWindows` — clustering alone was investigated and found
   insufficient: the double-booking could still occur depending on which
   of two same-day requirements happened to be resolved first, unless the
   window used to check a candidate's OTHER busy commitments is also
   widened for the requirement actually being scored. `getRequirementWindow`
   itself is UNCHANGED — every RAM (`fixed_rule`/`demand_forecast`)
   requirement's window, and the requirement's own window as stored on the
   `GeneratedDuty` (used for display and for RAM-to-RAM busy-window
   bookkeeping), are exactly as before; only the conflict-detection window
   for a `company_config` requirement was widened, and only at the two
   places that decide "does this employee conflict with this company
   duty."

**Before/after benchmark (same 152-flight heavy week, week of
2026-09-07, via a git worktree at the pre-fix commit):**

| Metric | Before | After |
|---|---|---|
| Foreign-company employees' working-days histogram | `{1:1, 2:20, 3:5, 5:8}` (34 employees, most at 2 days) | `{4:14, 5:20}` (all at 4 or 5 days) |
| Foreign-company employees OFF all week | 0 | 0 |
| Double-bookings (employee with two overlapping duties, real protected window vs RAM window) | **9** | **0** |
| `consecutive_off_violation` (hard) | 23 | 2 |
| `separated_off_days` (soft) | 32 | 35 |
| `unfilled_duty` | 4 | 5 |
| Gate duties / required | 73 / 73 | 73 / 73 (unchanged) |
| Boarding duties / required | 73 / 73 | 73 / 73 (unchanged) |
| Profiling duties / required | 60 / 61 | 60 / 61 (unchanged) |
| Mesure duties / required | 68 / 80 | 68 / 80 (unchanged) |
| Company Team duties / required | 121 / 121 | 120 / 121 |
| `rest_violation` (hard) | 0 | 0 |
| T1 Check-in zone placement duties for foreign-company employees | 0 | 0 (see note below) |

The one Company Team duty that went from filled to unfilled (121→120) is
the direct, correct consequence of fix #3: the previously double-booked
employee is no longer silently double-counted as covering both their RAM
duty and the company duty, so one of the two now correctly shows as a
real, honest shortfall instead of a fabricated double coverage. Every
Gate/Boarding/Profiling/Mesure count is byte-identical before and after,
confirming the fixes are scoped to foreign-company handling only.

**T1 Check-in placement duties for foreign-company employees stayed at
0 before AND after** — this is a genuine, disclosed limitation of the
CURRENT SEED DATA, not of the fix: `isEligibleForDefaultCheckinPlacement`
correctly requires the Check-in skill (an existing, unrelated, unchanged
requirement — see checkin-zone-placement.ts), and none of this seed
week's 34 foreign-company employees happen to hold that skill. The
mechanism itself is directly unit-tested and confirmed working (see
`tests/foreign-company-redeployment-default.test.ts` and the extended
`tests/checkin-zone-placement.test.ts`): a foreign-company employee who
DOES hold the Check-in skill is placed in a T1 Check-in zone for their
free time outside their protected window, exactly as the confirmed model
requires. Whether real Gulf Air/Qatar Airways/etc. ACEs hold a Check-in
qualification in reality is a real-world data question for RAM Handling,
outside this fix's scope.

## T1 Check-in architecture audit + derived-capacity refactor (RAM Handling / product owner, 2026-09-23)

**What was audited.** A live symptom — the same zone/day showing
"04:00–08:30 Main Check-in — Required 4 / Assigned 75" immediately
followed by "09:00–15:30 Main Check-in — Required 6 / Assigned 0" —
was traced to `lib/planning/weekly-plan-service.ts`'s
`findZoneRequirementIdFor`: it tried an exact-window string match between
a default-placement duty's fine-grained free interval and a demand
cluster's broad, bucket-aligned window (almost never equal), then fell
back to `zoneRequirements.find(r => r.day_of_week === day && r.zone === zone)`
— the FIRST requirement row for that zone/day, with **no time-overlap
check at all**. Nearly every placement duty for a zone/day landed on the
day's earliest demand cluster, inflating it, while every later cluster
for that zone got zero.

**Architectural conclusion.** The product owner's review (an authoritative,
11-point brief from a real CMN Check-in/Boarding agent) concluded this was
a symptom of a deeper mistake, not a lookup bug to patch: T1 Check-in was
being modeled as its own separately-assigned, separately-persisted duty
type, when it is actually the RESIDUE of an employee's rostered shift once
every real specific-duty interval is subtracted — a derived availability
fact, not a duty. The fix is architectural: compute Required (from the
flight schedule) and Available (from the roster + already-persisted
specific-duty intervals) as two separate timelines, built from real event
boundaries (a flight's Check-in-open/close instant, a shift start/end, a
specific-duty start/end) into ATOMIC periods, and compare them AT READ
TIME — never persist automatic default placement as a discrete duty row
that a broken lookup can mis-link.

**What was refactored:**
- New module `lib/planning/checkin-capacity-timeline.ts`: builds the
  per-day atomic-interval timeline (`buildDailyCapacityTimeline`), a
  per-zone display view with adjacent-equal periods merged
  (`mergeAtomicPeriodsForZone`/`buildZoneCoverageRowsForDay`), and the
  read-time reconstruction of "who is eligible and free" purely from
  already-persisted `weekly_plan_roster_entries` + `assignments` +
  `flights` (`buildEligibleEmployeeAvailabilityForDay`, reusing
  `duty-generation.ts`'s `computeBusyWindowsForDay` and
  `buildDayEffectivePoolFromRosterEntries` unchanged, and
  `checkin-zone-placement.ts`'s `isEligibleForDefaultCheckinPlacement`,
  now exported instead of private).
- `lib/planning/checkin-zone-placement.ts`: removed
  `computeDefaultCheckinZonePlacement`/`ZoneCoverageDuty`/`pickDefaultZone`
  entirely — the discrete-duty-generation architecture that caused the
  bug. `isEligibleForDefaultCheckinPlacement` and `subtractBusyWindows`
  remain, exported, as the shared primitives the new module and Find Agent
  both build on.
- `lib/planning/generate-draft-plan.ts` / `weekly-plan-service.ts`: no
  longer generate or persist a discrete `checkin_zone_assignments` row for
  automatic placement at all (`bundle.zoneAssignments` is always `[]`
  straight out of generation). `checkin_zone_requirements` (the DEMAND
  side) is unaffected — it was never the buggy part and is still
  generated and persisted exactly as before.
- `lib/planning/persisted-plan-view.ts`: `zoneCoverage` is now built from
  the derived capacity timeline (`required`/`available`/`gap`/`surplus`),
  not from counting assignment rows. A genuine human Find Agent commitment
  is still a real persisted row (`checkin_zone_assignments`,
  `source: "human_modified"`) and is surfaced separately as
  `manuallyAssigned`/`manuallyAssignedEmployees`, still reducing the gap.
  Where a Find Agent action needs a `checkin_zone_requirements` id to post
  to, it is resolved by a REAL overlap check against that day/zone's
  persisted demand-cluster rows (picking the largest `required_headcount`
  on a tie) — never the old "first row for this zone/day" fallback.
  Per-employee Agent Schedule zone duties now distinguish `"confirmed"`
  (a real human commitment) from `"available"` (derived default coverage,
  never a persisted duty — see `AgentZoneDuty.status` in `lib/types.ts`).
- **No schema migration was needed.** `checkin_zone_assignments` already
  had a `source` column distinguishing `"atlas_generated"` from
  `"human_modified"` (migration 0015); the fix is that generation simply
  never writes an `"atlas_generated"` row into it any more. `checkin_zone_requirements`
  and its `checkin_zone_requirement_contributing_flights` join table are
  unchanged and still written the same way.
- UI: `components/zone-coverage-card.tsx`, `components/planning-summary-bar.tsx`,
  `components/summary-drilldown-sheet.tsx`, `components/agent-day-detail.tsx`,
  and `app/planning/page.tsx` updated to the new `ZoneCoverageView` shape
  and to "Required X · Available Y · Gap Z" / "Surplus Z" semantics instead
  of "Required X / Assigned Y". `app/api/checkin-zone-assign/route.ts` and
  `app/api/checkin-zone-candidates/[zoneRequirementId]/route.ts` needed no
  logic changes — they already only cared about `human_modified` rows
  through the same `checkin_zone_requirements`/`checkin_zone_assignments`
  tables, and are in fact now MORE correct (no more spurious
  `atlas_generated` rows in their "already covered"/"already assigned"
  checks).
- `lib/planning/checkin-zone-demand.ts`: the Check-in-open timing constant
  changed from an unconfirmed 180 minutes to the product owner's CONFIRMED
  4 hours (`CHECKIN_OPEN_BEFORE_DEPARTURE_MINUTES = 240`); the closing
  point remains its own explicitly-named, still-unconfirmed constant
  (`CHECKIN_CLOSE_BEFORE_DEPARTURE_MINUTES`). The staffing coefficients
  themselves are untouched (still the same prototype values from
  `checkin-demand.ts`, per the explicit instruction not to invent a
  more-real-looking number).
- `lib/planning/roster-generation.ts` / `generate-draft-plan.ts`: Stage 6
  (`generateObligationToppedUpShifts`/`computeEmployeeDayCountTopUp`) now
  optionally accepts a per-day aggregate T1 demand-peak minute
  (`peakAggregateT1DemandMinuteForDay`, new in
  `lib/planning/zone-demand-aggregation.ts`, computed on the flight
  schedule alone, before Stage 6 runs). When more than one catalog shift
  code is already EQUALLY legal for a day being topped up, it now prefers
  one whose window covers that day's known demand peak instead of always
  the shortest-first code — a heuristic BIAS between otherwise-equal
  choices only; it never widens the legal set and never overrides a rest/
  consecutive-OFF/obligation constraint (see
  `tests/stage6-t1-demand-bias.test.ts`, including the explicit "never
  overrides a hard rest constraint" case). This directly, honestly does
  NOT eliminate all T1 shortages — see the benchmark below — and is not
  claimed to.

**Regression coverage added:** `tests/checkin-capacity-timeline.test.ts`
(the atomic-interval computation itself, including the exact "partial
overlap counted as full-window coverage" bug shape and the "spike then
zero" adjacent-window bug shape), `tests/stage6-t1-demand-bias.test.ts`,
and a rewritten `tests/zone-plan-integration.test.ts` (asserting the new
architecture's invariants against the real seeded week: `bundle.zoneAssignments`
is always empty out of generation, and `available` is always bounded by
real headcount and never zero right next to a real spike for the same
zone/day). `tests/checkin-zone-placement.test.ts` and
`tests/foreign-company-redeployment-default.test.ts` were updated to test
`isEligibleForDefaultCheckinPlacement` directly (the function that
survived) instead of the removed `computeDefaultCheckinZonePlacement`.
`tests/checkin-zones.test.ts` and `tests/zone-demand-aggregation.test.ts`
pass unmodified — the zone taxonomy/classification and the demand-cluster
computation were never the buggy part.

**Remaining known gaps (explicitly not solved by this refactor):**
- The real RAM management formula translating simultaneous-open-flight
  count into required headcount is still unconfirmed/prototype (same
  coefficients as before — see `checkin-zone-demand.ts`).
- The real Check-in CLOSING point relative to departure is still
  unconfirmed (`CHECKIN_CLOSE_BEFORE_DEPARTURE_MINUTES`).
- The Stage-6 T1-demand bias is a heuristic tie-break between already-legal
  choices, not an optimizer — a genuine, unavoidable T1 shortage (e.g. real
  demand at 17:00 with no legally-rested candidate available) still
  surfaces honestly as a real gap; it is never hidden or capped.
- Fatigue modeling and updated GMT shift definitions remain explicitly out
  of scope, deferred to a future phase per the product owner.
- An overnight employee shift and a flight whose Check-in-open window
  would reach into the previous calendar day are both still clamped to the
  same calendar day (pre-existing limitations of the modules this refactor
  reuses, not introduced here — see `checkin-capacity-timeline.ts`'s
  module doc comment).

## Stage-6 PRIMARY-pass T1 aggregate demand bias (RAM Handling, 2026-09-23 follow-up)

**Live finding.** On real imported flight data, early-morning (roughly
04:00–09:00) T1 Check-in was consistently and severely understaffed for
multiple zones, every day of the week (`Available` 0-1 against `Required`
2-8), while the Required/Available/Gap COMPUTATION itself (the
derived-capacity refactor immediately above) was independently verified
correct.

**Diagnosis (verified by re-reading the code, not just trusted):** the
root cause is NOT in `checkin-capacity-timeline.ts` — it is upstream, in
which shift codes Stage 6 actually chooses for the flexible pool.
- `lib/shift-templates.ts`'s catalog has two codes starting at 04:30
  (`MT02`, `JR02`); `lib/employee-generator.ts`'s General T1 Pool seed
  template never defaults anyone into either — the earliest seeded default
  is 05:45 (`MT01`/`JR01`).
- More importantly: `lib/planning/shift-generation.ts`'s
  `generateFlexiblePoolShifts` — the PRIMARY chooser, which CAN assign any
  catalog code to any eligible employee, not just an employee's seeded
  default — only ever scored candidates against real per-flight
  Gate/Boarding/Profiling/Mesure demand. "Check-in" was already listed in
  its `rolesToConsider`, but since the 2026-09-21 zone-model cutover no
  per-flight `"Check-in"` `StaffingRequirement` row is ever produced any
  more (see `weekly-requirements.ts`'s own doc comment on that cutover),
  so `demand.buckets[].demandByRole["Check-in"]` has been a structural,
  silent no-op ever since. Gate/Boarding demand clusters close to
  departure; Check-in opens a full 4h earlier
  (`CHECKIN_OPEN_BEFORE_DEPARTURE_MINUTES`) — so this function never had
  any real signal telling it to pull anyone onto an early code purely to
  cover Check-in.
- The existing bias immediately above
  (`computeEmployeeDayCountTopUp`'s `t1PeakDemandMinuteByDay`) is real and
  correctly implemented, but it only ever reaches the SECONDARY obligation
  top-up pass, which rarely triggers once the PRIMARY pass has already
  given an employee 5 working days — insufficient on its own to move the
  early-morning numbers in practice, which the diagnosis above confirms and
  the benchmark below demonstrates. It is kept, unchanged.

**What was changed:**
- `lib/planning/zone-demand-aggregation.ts`: added
  `aggregateT1DemandProfileForDay` — the full per-30-min-bucket aggregate
  T1 demand curve (summed across every zone, from the flight schedule
  alone), factored out of what `peakAggregateT1DemandMinuteForDay` already
  computed internally (that function now calls this one instead of
  duplicating the aggregation) so there is exactly one computation behind
  both the single-peak-minute bias and this new full-profile one.
- `lib/planning/shift-generation.ts`'s `generateFlexiblePoolShifts` gained
  an optional final parameter, `t1DemandByBucket` (the profile above). Any
  employee eligible for default T1 placement
  (`isEligibleForDefaultCheckinPlacement`, reused unchanged — NOT a new
  parallel "Check-in zone" hard qualification the way Gate/Boarding have a
  role) earns a small additional score, `T1_DEMAND_BIAS_WEIGHT = 0.001`,
  for each bucket of their candidate shift where they have no unmet HARD
  role to cover AND real T1 aggregate demand still exists. Because
  `T1_DEMAND_BIAS_WEIGHT * BUCKETS_PER_DAY (48) < 1`, a candidate covering
  strictly more real hard-role demand ALWAYS outranks one covering less,
  however much T1 aggregate demand the weaker candidate would also cover —
  this can only ever break a tie between otherwise-equally-legal,
  otherwise-equally-hard-productive candidates, or pull in an additional
  otherwise-idle candidate once every hard unit is already satisfied. It
  never widens the legal (rest/consecutive-OFF/obligation-respecting)
  candidate set computed earlier in the same function.
- `lib/planning/generate-draft-plan.ts`: the T1 profile is now computed
  ONCE, from the flight schedule alone, BEFORE Stage 6 runs at all (moved
  up from where the single-peak-minute version used to be computed, right
  before the secondary pass), and threaded through both passes of
  `runTwoPassShiftGeneration`/`runShiftGenerationPass` into
  `generateFlexiblePoolShifts`. `t1PeakDemandMinuteByDay` (still used by
  the unchanged secondary top-up pass) is now derived from the very same
  per-day computation rather than a separate one.

**This is still a HEURISTIC, best-effort weighting — not a joint
optimizer.** It never widens the legal candidate set, and a genuinely
unavoidable shortage (not enough legally-rested flexible-pool employees
that day, however weighted) still surfaces honestly through the unchanged
Required/Available/Gap computation — never hidden or capped. An extremely
tight scenario with heavily competing Gate/Boarding and T1 demand on the
same day could still produce a suboptimal choice; this is a bias among
otherwise-tied candidates, not a search over all legal rosters.

**Benchmark (before/after, real seed data — `lib/seed-data.ts`'s
`EMPLOYEES`/`FLIGHTS`/`CONFIG`, T1 Main Check-in, 04:00–09:00 window,
committed `HEAD` immediately before this fix vs. after it):**

| Day | Before — worst row in window | After — worst row in window |
|---|---|---|
| Monday | 05:00–05:45 Required 2 / Available **0** (Gap 2) | 05:00–05:45 Required 2 / Available **4** (Gap 0) |
| Tuesday | 06:30–07:15 Required 2 / Available **0** (Gap 2) | 06:30–07:15 Required 2 / Available **4** (Gap 0) |
| Wednesday | 05:00–07:20 Required 4 / Available 71-72 (Gap 0) | 05:00–07:20 Required 4 / Available 48-50 (Gap 0) |
| Thursday | 06:30–08:00 Required 2 / Available 2 (Gap 0) | 06:30–07:15 Required 2 / Available **6** (Gap 0) |
| Friday | 05:00–05:45 Required 2 / Available **0** (Gap 2) | 05:00–05:45 Required 2 / Available **4** (Gap 0) |
| Saturday | 06:30–07:15 Required 2 / Available **0** (Gap 2) | 06:30–07:15 Required 2 / Available **4** (Gap 0) |
| Sunday | 05:00–05:45 Required 2 / Available **0** (Gap 2) | 05:00–05:45 Required 2 / Available **4** (Gap 0) |

Whole-week total `gap × minutes` for T1 Main Check-in in the 04:00–09:00
window: **940 before, 0 after.** The genuine early-morning gap that
existed in the real committed seed data (worst single window: Required 2 /
Available 0) is fully closed once the primary pass can see the same
early demand the secondary pass already knew about. Honesty note: this
repo's demo seed data is comfortably overstaffed relative to its flight
volume (120 flexible-pool employees for 69 flights/week) — the ACTUAL
live-reported gap (`Available` 0-1 vs `Required` 2-8) is more severe than
what this seed data reproduces, because the live schedule's ratio of
flights to flexible staff is tighter than this demo's. The fix targets the
exact mechanism (Stage 6 blindness to T1 aggregate demand), verified
directly against `generateFlexiblePoolShifts` in
`tests/stage6-t1-primary-bias.test.ts`, and against the real, already-
committed seed data end to end; it is not claimed to reproduce the live
schedule's exact magnitude, which this repo does not have a fixture for.

**Regression coverage added:** `tests/stage6-t1-primary-bias.test.ts` —
(1) an idle, Check-in-eligible employee is pulled onto `MT02` purely for a
synthetic early T1 peak when nothing else needed them, and is NOT pulled
when the bias is omitted (byte-for-byte prior behavior); (2) a
Gate-and-Check-in-qualified employee's single shift still covers the same
real Gate requirement exactly once (never dropped, never duplicated) while
ALSO now covering the T1 peak, versus a later, T1-blind code chosen
without the bias; (3) a harsh prior-day shift that makes every code
touching the T1 peak illegally under-rested leaves the employee genuinely
unassigned — the shortage stays honest, no illegal shift is fabricated;
(4) a real hard-coverage advantage (more Gate/Boarding units covered)
always outranks a weaker candidate's larger T1-only soft score. Existing
suites (`tests/shift-generation.test.ts`, `tests/stage6-t1-demand-bias.test.ts`,
`tests/rest-invariant-hard.test.ts`, `tests/roster-generation-redesign.test.ts`,
`tests/foreign-company-redeployment-default.test.ts`,
`tests/foreign-company-double-booking.test.ts`, and the full remaining
suite) pass unmodified — full run: 406/406 tests, clean `next build`.

**Remaining known gaps (unchanged from immediately above, still honest):**
- The real RAM management staffing-coefficient formula is still
  unconfirmed/prototype; this fix changes WHO gets rostered when, never
  WHAT the required headcount number is.
- This is a heuristic weighting between already-legal candidates, not a
  true joint optimizer across Gate/Boarding and T1 demand on the same
  day — a scenario with extremely tight, genuinely competing demands on
  both sides at once could still produce a suboptimal (though always
  legal) choice.
- A genuinely unavoidable shortage (not enough legally-rested
  flexible-pool employees that day, full stop) is not eliminated by this
  fix and must not be — it still surfaces honestly through
  Required/Available/Gap, exactly as before.

## Capacity-timeline single-zone attribution bug fixed (RAM Handling, 2026-09-23 follow-up)

**Live finding.** On a real Supabase-backed deployment, for a real
regenerated plan, `T1 Main Check-in` showed healthy `Available` numbers
(4–70+, comfortable surplus) while `T1 Domestic Check-in` and
`T1 Italy/Spain Check-in` showed a persistent, unbroken
`Required 2 · Available 0 · Gap 2` in windows that DID overlap active
employee shifts (e.g. 04:00–07:15 for Domestic, 05:00–06:30 for
Italy/Spain — after the earliest catalog shift start, not before it). The
pattern repeated identically every day of the week.

**Diagnosis (confirmed by reading `lib/planning/checkin-capacity-timeline.ts`
in full).** The two fixes immediately above this one (the derived
Required/Available/Gap timeline, and Stage 6's T1-demand bias) are both
correct and were not touched. The bug was a THIRD, independent issue in
the SAME module that computes the timeline: at every atomic period, the
entire free/eligible-employee pool was attributed to a single zone —
`pickZoneForInstant` (`lib/planning/checkin-capacity-timeline.ts:159-171`
pre-fix), called once per employee inside the availability loop
(`lib/planning/checkin-capacity-timeline.ts:235-242` pre-fix) using the
SAME static, never-decremented `requiredByZone` snapshot for every
employee in that period. Because `t1_main_checkin` almost always has the
highest simultaneous `required` headcount of the three ordinary zones (it
serves the widest range of destinations — every UK/USA/Canada/Europe
flight except Italy/Spain), 100% of every free employee at a given instant
landed on Main, and `t1_domestic`/`t1_italy_spain` were structurally stuck
at `Available 0` even when the total employee pool, split sensibly, would
have comfortably covered all three zones at once. Reproduced directly
against the module's own logic (see `tests/checkin-capacity-timeline.test.ts`,
new "capacity SPLITS across zones" describe block) and against the real
Monday-2026-09-07 flight schedule from this session's own
`atlas_heavy_week_2026-09-07.csv` fixture (AT650→IST/Main, AT100+AT160→MAD/
Italy-Spain, AT150+AT302→FEZ+RAK/Domestic, all open simultaneously
03:15–08:35) — see the benchmark below.

**Fix.** `checkin-capacity-timeline.ts`'s per-instant attribution now
splits the free-employee pool across every ordinary zone with unmet
demand, instead of concentrating it into the single highest-demand zone
(`attributeFreeEmployeesForInstant`, replacing `pickZoneForInstant`'s
per-employee use). It is a greedy, max-remaining-gap fill: each free
employee, in order, is attributed to whichever zone currently has the
LARGEST unmet need (required minus already-attributed so far in that same
instant); a zone whose requirement is already fully covered receives no
more of the pool while a sibling zone still has a gap; once every zone is
fully covered (or every zone is at zero demand), any remaining surplus
employees are parked on the single highest-demand zone, exactly as the old
behavior did for that case. This stays a purely DERIVED, per-atomic-period
computation — no persisted duty rows, no change to demand computation
(`checkin-zone-demand.ts`), eligibility (`isEligibleForDefaultCheckinPlacement`),
or the manual Find-Agent commitment path (`checkin_zone_assignments`,
`source: "human_modified"`), any of which were explicitly out of scope.

**Benchmark (real Monday 2026-09-07 flight schedule, 20-employee MT02
(04:30–14:45) General T1 Pool cohort, all genuinely free):**

| Window | Zone | BEFORE | AFTER |
|---|---|---|---|
| 02:40–04:30 (before any shift starts) | Main | Req 2 / Avail 0 / Gap 2 | Req 2 / Avail 0 / Gap 2 (unchanged — genuine) |
| 03:15–04:30 (before any shift starts) | Italy/Spain | Req 2 / Avail 0 / Gap 2 | Req 2 / Avail 0 / Gap 2 (unchanged — genuine) |
| 03:40–04:30 (before any shift starts) | Domestic | Req 2 / Avail 0 / Gap 2 | Req 2 / Avail 0 / Gap 2 (unchanged — genuine) |
| 04:30–05:55 | Main | Req 2 / **Avail 20** / Gap 0 | Req 2 / Avail 16 / Gap 0 (still comfortable surplus) |
| 04:35–05:55 | Italy/Spain | Req 2 / **Avail 0** / **Gap 2** | Req 2 / **Avail 2** / **Gap 0** — RECOVERED |
| 04:30–06:55 | Domestic | Req 2 / **Avail 0** / **Gap 2** | Req 2 / **Avail 2** / **Gap 0** — RECOVERED |
| 06:55–07:15 | Domestic | Req 2 / **Avail 0** / **Gap 2** | Req 2 / **Avail 2** / **Gap 0** — RECOVERED |

Main never regresses into its own gap: it gives up only the surplus
employees Domestic/Italy-Spain actually needed (20→16 at 04:30–05:55) and
stays at `Gap 0` throughout. The pre-04:30 windows for all three zones are
unaffected by the fix, on purpose — see the honest limitation below.

**Fixed by better attribution vs. genuinely unavoidable, distinguished
explicitly:**
- FIXED (recovered coverage): every 04:30-onward Domestic and Italy/Spain
  gap above — real, simultaneous multi-zone demand, enough total people
  existed, they were just being misattributed entirely to Main.
- NOT fixed, and must NOT be fixed (genuine structural gap): any window
  strictly before 04:30, the earliest catalog shift start
  (`lib/shift-templates.ts`'s `MT02`/`JR02`) — e.g. Italy/Spain's
  03:15–04:30 (AT100/MAD opens Check-in at 03:15, a full 75 minutes before
  any employee can be on shift). No attribution scheme can recover coverage
  that does not exist yet; this must keep showing as a real
  `Required > 0 / Available 0 / Gap > 0` after the fix, and the new test
  `"REGRESSION: a window entirely before the earliest catalog shift start
  is still a real, unavoidable structural gap"` (`tests/checkin-capacity-timeline.test.ts`)
  asserts exactly that.

**Regression coverage added:** `tests/checkin-capacity-timeline.test.ts`
gained 5 new tests (12 total in that file, up from 7): a sufficient shared
pool splits across Main+Domestic; a sufficient shared pool splits across
Main+Italy/Spain; an insufficient shared pool still shows a real, honest
gap split fairly across both zones (never fabricated coverage); a zone
already fully covered receives no more of the pool even with employees
left over (surplus still lands on the highest-demand zone); and the
before-any-shift-starts case still shows a genuine, unhidden gap. Full
suite: 411/411 tests pass (406 immediately before this fix + 5 new), and
`npm run build` is clean. The Stage-6 primary/T1-demand-bias suites
(`tests/stage6-t1-primary-bias.test.ts`, `tests/stage6-t1-demand-bias.test.ts`)
and the derived-capacity-timeline integration suite
(`tests/zone-plan-integration.test.ts`) all pass unmodified — neither of
the two prior fixes was touched or regressed.

**Remaining honest limitation.** The fix is a per-instant, greedy
max-remaining-gap (max-min-fair) split, NOT a true joint optimizer across
all ordinary zones and all atomic periods simultaneously. It always
produces the fairest possible split for a SINGLE instant (no zone is left
at a bigger gap than another while a sibling zone already has surplus),
but it cannot "save" capacity from an easy atomic period for a harder one
a few minutes later, and it can only reduce, not eliminate, an insufficient
pool's total shortfall (see the "insufficient shared pool" test above,
where a genuine 5-person total demand against a 3-person pool still leaves
a real Gap 1 / Gap 1 split, correctly, rather than inventing coverage). An
extremely tight multi-zone conflict whose shape changes every few minutes
could still produce more employee-to-zone attribution churn (see
`buildEmployeeZoneAvailabilitySegments`) than a hypothetical whole-shift
optimizer would choose — the Required/Available/Gap numbers themselves are
always correct at each instant regardless.

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

## 2026-09-23 addendum: RAM Handling's GMT+1 → GMT operational time reference change (effective-dated shift regime)

RAM Handling switches its operational time reference from GMT+1 to GMT on
**Sunday 2026-09-20**. Per the product owner, this is confirmed to be a
real flight-program and employee-shift-time change, not a display/timezone
relabeling — RAM's own change sheet gives new entrée/sortie clock times
for several shift codes effective on that date. The flight schedule itself
(`Flight.scheduled_departure` etc.) stays authoritative and untouched by
this work — only **employee shift template resolution** (the
entrée/sortie a `shift_code` like `NR01` or `JR01` actually means) is now
date-dependent.

### Architecture: effective-dated resolution, not a global find-and-replace

`lib/shift-templates.ts` now holds three shift-time tables instead of one:

- `SHIFT_CODES_GMT_PLUS_1` — the OLD regime, active for every real
  calendar date strictly before `REGIME_CHANGE_DATE` ("2026-09-20").
  Unchanged from what the catalog always was.
- `SHIFT_CODES_GMT_SPECULATIVE` (unexported, historical only) — a GUESS
  made before RAM's real change sheet existed, never applied to any real
  date. Kept only as the provenance record for several INHERITED fields
  below (the best available fallback where the real document is silent),
  and deliberately renamed away from the old generic `SHIFT_CODES_GMT`
  name so it can never be confused with the new, actually-effective table.
- `SHIFT_CODES_GMT_EFFECTIVE_2026_09_20` — the NEW regime, active for
  every real calendar date on or after `REGIME_CHANGE_DATE`. Built
  field-by-field from a row-by-row audit of RAM's real change sheet
  against the OLD catalog (full per-code table below).

`resolveShiftRegime(date: string)` does the actual resolution:
`date >= REGIME_CHANGE_DATE ? "POST_2026_09_20" : "PRE_2026_09_20"` — a
plain ISO-string comparison, correct because every date in this app is
always a real "YYYY-MM-DD" string, never a timestamp. Every shift-time
lookup (`getShiftTimes`, `getShiftTimesAs`, `getShiftDurationHours`,
`restHoursForDailyRepeatingShift`, `shiftCatalogForDate`) now takes a
**required** `date` parameter — deliberately not defaulted, so a caller
can never silently guess a regime. This means:

- **No global flip.** There is no code path that finds "every NR01 sortie
  in the database" and rewrites it. A plan for a week entirely before
  2026-09-20 keeps producing its original OLD-regime times forever,
  because every read of it re-resolves from that week's own real dates,
  which never change.
- **Per-day, never per-week, resolution.** 2026-09-20 is a confirmed
  Sunday, so a displayed Monday-Sunday week straddles the boundary
  exactly once, on its last day. Every per-day shift-template lookup in
  the planning pipeline resolves `date = flightDateFor(weekStart, day)`
  fresh for that specific day — see `tests/shift-regime.test.ts`'s
  "a real week spanning both regimes" suite, which proves Monday-Saturday
  of the week containing 2026-09-20 resolve `PRE_2026_09_20` while that
  week's Sunday alone resolves `POST_2026_09_20`.
- **`SHIFT_CODES`** is kept as an export, but is now documented as
  code-list-only (`Object.keys(SHIFT_CODES)` for UI dropdowns) — its
  VALUES must never be read for a date-sensitive computation. Both
  regimes share an identical 13-code key set, so this is safe.
- **`TRANSPORT_METADATA`** (new export) preserves the change sheet's
  personnel-transport/circuit rows (a shuttle bus's own departure/arrival,
  not an employee's working shift) that do not describe operational
  availability at all. Documented explicitly as burden/reporting time,
  never to be used for eligibility, rest, or T1 capacity — reserved for a
  possible future fatigue model. One source row (`transportEquipeAF`'s
  sortie) carries a "2027" date that reads as a likely typo for 2026; this
  is flagged in the code comment rather than silently corrected or
  silently trusted.
- **`LEGACY_BASELINE_DATE`** ("2020-01-01", new export) marks a value as
  an intentionally-static seed/baseline number with no real plan date in
  scope (see the employee-generator/seed-data section below) — never used
  by any real per-date planning read.

### Per-code classification (CONFIRMED / INHERITED / AMBIGUOUS)

| Code | OLD (GMT+1) entrée–sortie | NEW (GMT, from 2026-09-20) entrée–sortie | Confidence |
|------|---------------------------|-------------------------------------------|------------|
| JR01 | 05:45–18:15 | 05:45–18:30 | entrée CONFIRMED (unchanged) / sortie CONFIRMED (changed — "Circuits Sortie Brigade Matin") |
| JR02 | 04:30–16:45 | 03:45–16:45 | entrée INHERITED / sortie INHERITED (transport-labeled row only; suspect "2027" date) |
| MT01 | 05:45–14:45 | 05:45–15:00 | entrée CONFIRMED (unchanged) / sortie CONFIRMED (changed, shared w/ MT02 — "Circuits Sortie Équipe Matin") |
| MT02 | 04:30–14:45 | 03:45–15:00 | entrée INHERITED / sortie CONFIRMED (changed, shared w/ MT01) |
| MT03 | 05:45–15:45 | 05:45–14:45 | entrée CONFIRMED (unchanged) / sortie INHERITED |
| NR01 | 08:00–16:45 | 08:00–17:00 | entrée CONFIRMED (unchanged) / sortie CONFIRMED (changed — "Horaire Administratif") |
| NR02 | 08:00–18:15 | 08:00–18:15 | entrée INHERITED / sortie INHERITED (not mentioned anywhere in the document) |
| AP01 | 13:45–22:45 | 13:45–22:45 | entrée CONFIRMED (unchanged) / sortie AMBIGUOUS (document gives a value but it can't be confidently assigned between AP01/AP02 — OLD value kept rather than guessed) |
| AP02 | 13:45–23:15 | 13:45–23:15 | entrée CONFIRMED (unchanged) / sortie AMBIGUOUS (same reason as AP01) |
| AP03 | 17:45–02:00 | 17:45–01:15 | entrée CONFIRMED (unchanged) / sortie INHERITED |
| AP04 | 13:45–02:00 | 13:45–01:15 | entrée CONFIRMED (unchanged) / sortie INHERITED |
| NT01 | 17:45–06:15 | 17:45–06:30 | entrée CONFIRMED (unchanged) / sortie CONFIRMED (changed — "Circuits Sortie Équipe Nuit + Brigade Nuit") |
| N8 | 21:00–06:15 | 21:30–06:30 | entrée CONFIRMED (changed) / sortie CONFIRMED (changed) |

`FEMALE_ENTREE_POLICY` (the minimum clock-in policy, never a shift code)
was separately audited and confirmed unchanged by the new document for
both regimes — no update needed.

### Consumers threaded with the real per-date resolution

Every real code path that resolves an employee's shift-code time now
receives an explicit, per-day real calendar date (never a default, never
one date for a whole week) — file:line references are to the state as of
this addendum:

- `lib/planning/duty-generation.ts` — `effectiveShiftForDay` (`getShiftTimesAs` calls) and `buildDayEffectivePoolFromRosterEntries`, both given a required `date`; `generateDutiesForDay` takes a required `date` param.
- `lib/planning/shift-generation.ts` — `generateFlexiblePoolShifts` takes a required `date` (2nd param) and enumerates `shiftCatalogForDate(date)` instead of the old static `SHIFT_CODES`; `enforceRestInvariantAcrossWeek` takes a required `weekStart` and resolves `flightDateFor(weekStart, day)` per day inside its main walk and its cyclic Sunday→Monday wrap check.
- `lib/planning/roster-generation.ts` — `shortestFirstCatalogCodes(date)` now takes a date and is recomputed fresh per day inside `computeEmployeeDayCountTopUp` (its old single precomputed `catalogCodes` parameter was removed entirely, since a straddling week can no longer have one fixed catalog); `generateObligationToppedUpShifts` takes a required `weekStart`.
- `lib/planning/specialized-team-generation.ts` — `assignPoolToWindow(WithRoles)`, `generateProfilingMesureShifts`, and `generateForeignCompanyShifts` all resolve `date = flightDateFor(weekStart, day)` per day and pass it down to every shift-time lookup.
- `lib/foreign-shift-planning.ts` — `selectCompatibleShiftCode(s)` and `planForeignCompanyDay` take a `date` parameter (see the documented exception below) and enumerate `shiftCatalogForDate(date)`.
- `lib/planning/checkin-capacity-timeline.ts` — `buildEligibleEmployeeAvailabilityForDay` takes a required `date`, threaded to `buildDayEffectivePoolFromRosterEntries`; the atomic-interval timeline functions themselves need no date awareness since they operate on already-resolved availability windows.
- `lib/planning/generate-draft-plan.ts` — `generateDraftWeeklyPlan` takes a required `weekStart` and resolves `date = flightDateFor(weekStart, day)` at every per-day shift-time read across both Stage-6 passes, the rest-hours-scheduled-this-window accumulation, and duty generation.
- `lib/planning/validation.ts` — `checkRestBetweenDays`, `computeScheduledWeeklyHours`, `checkAverageWeeklyHours`, `auditAverageWeeklyHoursFeasibility`, `auditStaticShiftRestFeasibility`, `validateWeeklyPlan` all take a required `weekStart` and resolve each day's own date, including the cyclic Sunday→following-Monday wrap case (which resolves the wrapped day from `shiftWeek(weekStart, 1)`).
- `lib/planning/rotation-context.ts` — `deriveTransitionContextFromPriorPlan` takes the PRIOR plan's own `priorWeekStart` (resolving the regime effective on that prior plan's real last day, never the new week's); `deriveFallbackBoundaryContext` takes `weekStart` and resolves a stand-in date one week before it.
- `lib/planning/weekly-plan-service.ts`, `lib/planning/persisted-plan-view.ts`, `lib/planning/weekly-plan-view.ts` — thread `weekStart` through to every downstream date-resolved call.
- `app/api/candidates/[requirementId]/route.ts` and `app/api/assign/route.ts` — pass `targetFlight.flight_date` (the real, authoritative per-flight date) into `buildDayEffectivePoolFromRosterEntries`.
- `app/api/checkin-zone-candidates/[zoneRequirementId]/route.ts` and `app/api/checkin-zone-assign/route.ts` — compute `flightDateFor(plan.week_start, requirement.day_of_week)` and pass it the same way.
- `lib/scoring.ts` — audited, needs **no changes**: `scoreCandidates` only ever reads already-resolved `shift_start`/`shift_end`/`rest_before_shift_hours` fields off the `Employee` objects its callers hand it; it never calls into `shift-templates.ts` directly, so it is correct by construction once its callers pass correctly-resolved data.

### Consumers that could NOT be made fully, uniformly date-aware — flagged, not hidden

- **`lib/foreign-shift-planning.ts`'s `selectCompatibleShiftCode(s)` and
  `planForeignCompanyDay`** take `date` as a **defaulted** parameter
  (`= LEGACY_BASELINE_DATE`), not a required one, unlike every function in
  `lib/shift-templates.ts` itself. This is a deliberate, documented
  compromise: the real planning caller
  (`specialized-team-generation.ts`) always passes its own real resolved
  date explicitly, but `tests/foreign-shift-planning.test.ts` exercises
  these functions in isolation with no date/regime concept at all, and
  forcing every one of those unit tests to adopt a date was judged not
  worth the churn for a pure unit-level matching function. The
  consequence: a hypothetical NEW caller of these functions that forgets
  to pass `date` silently gets OLD-regime (`LEGACY_BASELINE_DATE`)
  resolution instead of a compile error. This is a real, narrower
  consistency gap than the rest of the pipeline (which makes `date`
  strictly required everywhere else) and is called out here rather than
  presented as fully closed.
- **`lib/employee-generator.ts` and `lib/seed-data.ts`'s static baseline
  fields** (`Employee.shift_start`/`shift_end`/`rest_before_shift_hours`
  built once at generation/seed time) are **not** made date-aware — they
  are built with no real plan date in scope at all (seed-time script
  generation, not a real calendar plan), so there is no date to resolve
  against. These now explicitly use `LEGACY_BASELINE_DATE` (2020-01-01,
  pre-regime) to keep their numeric values identical to what they always
  were, and are documented as durable fallback/legacy data that a
  generation-driven employee's real per-date resolution
  (`effectiveShiftForDay`, `resolvePlanRosterEntry`) already overrides
  wherever a real plan roster exists. A caller that read one of these
  static fields directly for a real POST-2026-09-20 date, bypassing the
  per-date resolution path entirely, would see a stale OLD-regime number
  — this is the same pre-existing "baseline vs. resolved" distinction this
  document's earlier sections already describe for `effectiveShiftForDay`,
  now extended to also cover regime, not a new gap this work introduced.
- **UI components** (`components/employees/employee-filters.tsx`,
  `components/agent-schedule-filters.tsx`) were audited and read only
  `Object.keys(SHIFT_CODES)` (the code list, identical across regimes) for
  dropdown options — never a time value — so they need no changes.
  `components/employees/employee-drawer.tsx` only displays already-
  resolved `Employee.shift_start`/`shift_end` strings handed to it by the
  API layer; it never reads the catalog directly.

### Test coverage

A new dedicated file, `tests/shift-regime.test.ts` (27 tests), covers:
the boundary itself (2026-09-19 PRE vs. 2026-09-20 POST, and dates far on
either side); that both regimes share an identical 13-code key set;
per-code OLD-vs-NEW resolution for a CONFIRMED-changed code (JR01, NR01),
an AMBIGUOUS field kept intentionally at its OLD value (AP02), and
immutability of historical lookups after POST-date lookups have run;
overnight-shift correctness (AP03, AP04, NT01, N8) including the 24h-wrap
duration math on both sides of the boundary; duration calculations for
changed codes (NR01, JR01) and an INHERITED code (MT02); a 15h rest
calculation across a boundary-crossing shift pair, proving each day's own
regime is used rather than one regime for the pair; foreign-company shift
compatibility resolved per date via `selectCompatibleShiftCode(s)`; and a
real week spanning both regimes (`weekStart = "2026-09-14"`, whose Sunday
is 2026-09-20) resolved per-day rather than per-week, including running
the full `generateDraftWeeklyPlan` pipeline across that exact straddling
week without error.

Full suite: 53 test files, 438 tests pass (411 immediately before this
change + 27 new in `tests/shift-regime.test.ts`), and `npm run build` is
clean. The T1 derived-capacity-timeline suite
(`tests/checkin-capacity-timeline.test.ts`, `tests/zone-plan-integration.test.ts`),
the Stage-6 demand-bias suites (`tests/stage6-t1-demand-bias.test.ts`,
`tests/stage6-t1-primary-bias.test.ts`), and the foreign-company suites
(`tests/foreign-company-roster-topup.test.ts`,
`tests/foreign-company-double-booking.test.ts`,
`tests/foreign-company-redeployment-default.test.ts`,
`tests/foreign-company-window.test.ts`) were all explicitly re-run and
pass unmodified — none of the three prior fixes documented above was
touched or regressed by this change.

### Remaining honest limitations

- The AMBIGUOUS AP01/AP02 sortie fields, and every INHERITED field, are
  the model's best-available values, not confirmed by RAM's document —
  if/when management resolves the ambiguity or supplies the missing
  rows, only `SHIFT_CODES_GMT_EFFECTIVE_2026_09_20` in
  `lib/shift-templates.ts` needs to change; no other file's logic depends
  on which specific values those fields hold.
- Separately, the `transportEquipeAF` "2027" date is flagged, not silently corrected —
  if it is confirmed to be a genuine 2027 effective date rather than a
  typo, `TRANSPORT_METADATA` would need a second, later effective-dated
  entry of its own (not implemented, since transport metadata is not yet
  consumed by any real computation).
- `lib/foreign-shift-planning.ts`'s defaulted (not required) `date`
  parameter, described above, remains a real, narrower consistency gap
  versus the rest of the pipeline's strictly-required dates.
- This work resolves shift-TIME regime only. It does not attempt to
  infer or apply any other operational change RAM's transition might
  carry (headcount, route, or policy changes outside the shift catalog)
  — none were described in the task's scope, and none are assumed here.

## 2026-09-24 addendum: fatigue-aware roster planning, part 1 — OFF/OFF root-cause fix + fatigue model core (not yet wired)

Two separate deliverables. Part A changes planning behaviour. Part B only
adds architecture and tested pure functions. Nothing in Part B is
consulted by the planner yet.

### Part A — why separated OFF days kept appearing, and the fix

**Root cause.** For a flexible ACE, "OFF" was purely a side effect. Stage 6
(`generateFlexiblePoolShifts`) assigned shifts per 30-min bucket and knew
nothing about anyone's weekly OFF/OFF block, so an employee was OFF on a
day only because Stage 6 didn't happen to need them that day. The Stage-6.5
top-up (`computeEmployeeDayCountTopUp` / `chooseTopUpReservedOffDays`) ran
a correct, wraparound-aware sliding-window search, but it could only
choose among the days Stage 6 had already left free. It could not
un-scatter a pattern Stage 6 had produced. Diagnosis on seed data found a
second, related cause: an early code (e.g. MT02) placed on a day that is
not adjacent to the employee's OFF block silently forces the PREVIOUS day
OFF, because no catalog code ends early enough for 15h rest before it.
The top-up's myopic per-day code choice (and its post-hoc Sunday→Monday
wrap drop) also left some ACEs with 3 OFF days.

**Fix.**
- `lib/planning/off-window.ts` — `planPreferredOffWindows` picks each
  flexible ACE's preferred consecutive OFF window BEFORE Stage 6. The
  heuristic is a prototype judgment call: deterministic demand-aware
  water-filling. It estimates required headcount per day, starts with
  `offCapacity = poolSize - required`, then walks ACEs in id order and gives
  each the cyclic window (Sun–Mon wrap included) with the best remaining
  capacity (highest minimum, then highest sum, ties to earliest). After each
  choice it lowers that window's capacity. OFF blocks therefore land on
  low-demand days and spread out. It skips windows that would extend a
  KNOWN real prior-day OFF run across the week boundary. It uses only
  `prior_plan` provenance, never the static fallback, whose `null` for the
  flexible pool means "no data", not "OFF".
  `chooseBestCyclicWindowStart` is the one shared cyclic window search, used
  by both this planner and `chooseTopUpReservedOffDays`.
- `lib/planning/stage6-score-tiers.ts` centralizes the Stage-6 score
  hierarchy. Stage 6 subtracts a tier-3 penalty for each structural conflict
  with the employee's window: today is inside the window, or the code
  forces a neighbouring day OFF outside it.
- In the Stage-6.5 top-up:
  - Reservation now tie-breaks toward the pre-planned window.
  - The rest lookahead also checks neighbours that the top-up itself
    added, and it checks the same-week Sun↔Mon wrap when choosing a code
    rather than dropping the day afterwards.
  - Codes that keep a free neighbouring day fillable are preferred.
  - A bounded backtracking pass fills the non-reserved days. Its first leaf
    is exactly the old greedy walk, so the result is unchanged whenever
    greedy already succeeded.

  None of these changes relaxes a rule. The shared top-up core also serves
  foreign-company employees, and four of them moved from 3 OFF days to the
  5+2 target as a result.
- `generateDraftWeeklyPlan` gains two optional parameters:
  `priorWeekBoundaryProvenance` (`weekly-plan-service.ts` passes it) and
  `planningOptions.offWindowStructureBias`, which is on by default and is
  used for A/B tests.

**Score hierarchy.** For each tier, the maximum total it can contribute for
one candidate on one day is smaller than the smallest difference the tier
above it can make:

| Tier | Meaning | Constant | Max total |
|---|---|---|---|
| 0 | hard legality (rest, qualification, population) | filtered before scoring | — |
| 1 | hard coverage per (bucket, role) | `HARD_COVERAGE_UNIT = 1` | — |
| 2 | T1 aggregate Check-in refinement | `T1_DEMAND_BIAS_WEIGHT = 0.001` / bucket | 0.048 < 1 |
| 3 | consecutive OFF/OFF structure | `OFF_WINDOW_STRUCTURE_CONFLICT_WEIGHT = 0.00003` / conflict, ≤ 3 | 0.00009 < 0.001 |
| 4 | fatigue (RESERVED, not wired) | `FATIGUE_TIER_BUDGET = 0.00001` | < 0.00003 |
| 5 | fairness / continuity / id | lexicographic tie-break only | — |

The structure penalty is always smaller than the smallest positive coverage
score (one T1 bucket). It can reorder candidates, but it can never push a
covering candidate out of selection or create a gap.

**Results on seed data** (120 flexible ACEs, `unfilled_duty` stays 0,
`rest_violation` stays 0):

| Week | `separated_off_days` | 5 WORK + 2 consecutive OFF | ACEs with ≥ 3 OFF days |
|---|---|---|---|
| 2026-08-31 (GMT+1) | 26 → 3 | 83 → 116 | 10 → 0 |
| 2026-09-21 (GMT) | 12 → 2 | 71 → 117 | 36 → 0 |

The earlier "12" in the GMT week was low only because 36 ACEs had 3 OFF
days, which falls outside the separated check's scope. Rosters for the
fixed-cycle teams (Transit, Leaders, Duty Officers), Profiling/Mesure and
Caisse/BCB are byte-identical.

**Still legal and still flagged.** Separation remains a legal fallback. When
coverage or rest genuinely forces it (for example, the only qualified ACE
is needed Mon/Wed/Fri/Sun), the result is separated and
`checkSeparatedOffDays` still reports the non-blocking `separated_off_days`
issue. This case is pinned in `tests/stage6-off-window-bias.test.ts`.

**Remaining limits:**
- The demand estimate ignores qualifications.
- Cross-week continuity uses only the prior Sunday. It cannot tell a
  Sat–Sun block from a Sun–Mon block, so a real prior-Sunday OFF simply
  excludes Monday windows.
- Stability from week to week comes from the deterministic ordering, not
  from an explicit multi-week anchor.

### Part B — fatigue model core (architecture only, NOT wired)

- **`lib/fatigue-config.ts`** follows the conventions of `fairness-config.ts`:
  - All weights and thresholds are centralized and each can be set to zero
    on its own.
  - The weights are explicitly synthetic and unconfirmed; they are not
    scientific or RAM-validated values.
  - `FATIGUE_MODEL_ENABLED = false`, so `DEFAULT_FATIGUE_CONFIG` is a true
    no-op. `PROTOTYPE_FATIGUE_CONFIG` has the same weights with the model
    enabled.
- **`lib/planning/fatigue-model.ts`** contains pure functions:
  - `computeShiftBurden`: duration plus early, night and late terms,
    computed on real `getShiftTimesAs(code, date)` times.
  - `computeTransitionBurden`: a bounded start-time-swing cost. It is never
    a rest verdict.
  - `accumulateFatigue`: difficult days compound in runs; OFF days give
    geometric recovery with a bonus for consecutive OFF days and a per-day
    cap of 0.75, so one OFF day never erases accumulated burden.
  - `explainFatigueFactors`: neutral, digit-free labels.
  - A named breakdown object for each day.

  **Nothing in Stage 6, the top-up or `lib/scoring.ts` imports it yet.** A
  test asserts this. When the next phase wires it in, it must fit inside
  `FATIGUE_TIER_BUDGET`.
- **Transport burden is intentionally inert.** `transportBurdenWeight = 0`.
  `TRANSPORT_METADATA` was judged not reliable enough for a quantitative
  number, for these reasons:
  - It covers only 2 groupings and 5 of 13 codes.
  - It has values for the GMT regime only.
  - The `transportEquipeAF.sortie` row carries the "2027" date caveat.
  - That same row (15:15) is earlier than JR02's own 16:45 sortie, which is
    inconsistent.
  - It records shuttle times, not commute time or availability.

  The architecture is ready for a later phase: an optional `transportContext`
  is threaded through the burden functions, and `lookupTransportContext`
  returns `{known:false}` rather than guessing. Transport never feeds
  eligibility, availability, rest or capacity.
- **Incoming fatigue state** (`lib/planning/fatigue-continuity.ts`,
  `deriveIncomingFatigueState`) calls rotation-context's own derivations for
  each prior-week day, using `deriveTransitionContextFromPriorPlan` and the
  new per-day `deriveFallbackContextForDay` (extracted from
  `deriveFallbackBoundaryContext` with unchanged behaviour). It returns one
  of three distinct shapes:
  - **`prior_plan`**: a real persisted predecessor plan.
  - **`fallback_static_baseline`**: marked `approximate: true`. It is used
    only for employees whose static baseline is authoritative.
  - **`unknown`**: returned when there is no context, when the employee is
    absent from the predecessor plan, or when a demand-driven employee has
    only a baseline. It never fabricates a history.

Tests: 438 → 494. The new files are `tests/stage6-off-window-bias.test.ts`,
`tests/fatigue-model.test.ts` and `tests/fatigue-continuity.test.ts`. No
existing test was modified. `npm run build` is clean.

## 2026-09-24 addendum: fatigue-aware roster planning, part 2 — fatigue wired into the planner (OFF by default)

**`FATIGUE_MODEL_ENABLED` stays `false` globally.** This phase builds the
wiring and proves it works when a caller explicitly passes an enabled
`FatigueConfig`. No real plan changes: every real caller
(`weekly-plan-service.ts`, `weekly-plan-view.ts`, the API routes) passes no
fatigue input, and no planner module imports `FATIGUE_MODEL_ENABLED`,
`DEFAULT_FATIGUE_CONFIG` or `PROTOTYPE_FATIGUE_CONFIG` to switch itself on.
Enabling it for real plans is a separate future decision. No numeric weight
in `lib/fatigue-config.ts` was changed, and transport burden stays at 0.

### What got wired where

- **Planner glue: `lib/planning/fatigue-planning.ts` (new).**
  - `projectFatigueForShift` projects one (employee, code, real date)
    option. It takes the state entering the day, adds the code's
    date-resolved burden plus the transition from the last worked shift,
    and returns the resulting state.
  - `FatigueLedger` carries running state day by day:
    `createFatigueLedger`, `advanceFatigueLedger`,
    `stage6FatigueContextFromLedger`. An employee with no incoming state is
    an explicit `UnknownFatigueState`.
  - `explainFatigueChoice` produces the explanation labels.
- **Stage 6 (`generateFlexiblePoolShifts`).** A new optional trailing
  `fatigueContext` parameter carries the tier-4 term (formula below).
  Running state across days is kept by a `FatigueLedger` in
  `generate-draft-plan.ts`'s `runShiftGenerationPass`. It advances once per
  day because an employee gets at most one shift per day, so state cannot
  change inside a day's greedy loop. The ledger covers Stage-6 days only;
  top-up days are added later and ordered separately.
- **Stage-6.5 top-up.** `computeEmployeeDayCountTopUp` and
  `generateObligationToppedUpShifts` take an optional trailing
  `TopUpFatigueOptions` / `fatigueConfig`. Among one day's legal codes it
  prefers the lower-burden code. Burden here is the code's own
  date-resolved burden plus the transition in from the previous worked
  shift and out to the next worked shift, quantized with the same
  `fatigueScoreSteps`. This ordering sits strictly below the existing
  T1-peak and OFF/OFF neighbour-feasibility preferences. It never adds,
  removes or legalizes a code, and it never changes how many days get
  filled.
- **Foreign-company distribution.** The real planner path is
  `generateForeignCompanyShifts`, not `buildForeignCommitmentAssignments`
  (legacy seed baseline). It takes an optional trailing
  `ForeignFatigueOptions`. On each flight day the team pool is sorted by:
  1. the resulting burden of taking that day's commitment code;
  2. least-used hours;
  3. original order.

  This ordering happens before the unchanged `assignPoolToWindowWithRoles`
  walk. That walk still tries every member until the confirmed headcount
  is met, so fatigue can never cause, hide or delay a shortfall. Required
  coverage always wins. The ranking uses the day's combined-window code;
  a member's actual code may differ if their rest requires it.
- **Stage 9 / Find-Agent (`scoreCandidates`).** A new
  `fairness_weights.fatigueWeight` (optional, default 0) and an optional
  `fatigue: CandidateFatigueInput` parameter, forwarded by
  `generateDutiesForDay`. `generateDraftWeeklyPlan` builds the input from
  the final roster: each employee's state entering each day.
- **`generateDraftWeeklyPlan`** gains
  `planningOptions.fatigue = { config, incomingSeeds? }`. `incomingSeeds`
  maps employees to seeds from `deriveIncomingFatigueState` (`prior_plan`,
  approximate `fallback_static_baseline`, or `unknown`); an employee with
  no seed is treated as unknown. `weekly-plan-service.ts` does not derive
  or pass seeds yet. That is part of the future enablement.

### Final Stage-6 fatigue formula (tier 4)

```
resultingBurden = accumulateFatigue(stateEnteringToday,
                    burden(code, realDate) + transition(lastWorked -> code)).accumulatedBurden
fatigueSteps    = clamp(round(resultingBurden / 0.01), 0, 9999)      // fatigueScoreSteps
score           = hard*1 + t1*0.001 - conflicts*0.00003 - fatigueSteps*1e-9
```

The fatigue term's maximum total is 9999 × 1e-9 = 0.000009999. That is
below `FATIGUE_TIER_BUDGET` (0.00001), which is below one OFF/OFF
structural conflict (0.00003). Tiers 3 and 4 together (≤ 0.000099999)
are still below one T1 bucket (0.001), so a covering candidate always
scores more than 0.

Fatigue therefore only reorders candidates that are tied on hard coverage,
T1 and OFF/OFF structure. Among those, it picks the lower resulting burden:
- the less-loaded employee for a given code;
- the less burdensome code for a given employee.

Integer steps keep score comparisons exact. With `fatigueSteps = 0` the
score is bit-identical to the old formula.

### `scoreCandidates`: fatigue and workload hours stay separate

The two signals are never summed into one number. Within the `recommended`
group only, they are two lexicographic keys in a fixed order:

- **(4a) workload hours**, when `workloadHoursWeight > 0`.
- **(4b) fatigue burden**, when `fatigueWeight > 0` and the fatigue input's
  config is enabled. Lower recent accumulated burden ranks first. An
  unknown history counts as a neutral 0.
- **Stable input order** breaks any remaining tie.

Hours comes first on purpose. Switching fatigue on can only break ties
that hours leaves, so it never reorders a pair the shipped hours signal
already separates. The relative size of the two weights does not change
this key order. Fatigue never excludes a candidate, never lifts a flagged
candidate above a recommended one, and never bypasses the hard gates
(roster, team, protected-window overlap, shift overlap, skill or
authorization).

Stage 6 ranks differently: it places fatigue (tier 4) above its own
hours-so-far tie-break. That tie-break is an internal load-spreading
heuristic, not the business workload-fairness dimension.

### Explainability

These fields are populated only when the fatigue model is enabled:
- `GeneratedShiftAssignment.fatigueReason?: string[]` on Stage-6, top-up
  and foreign-roster assignments;
- `CandidateResult.fatigueReason?: string[]` on recommended candidates.

The labels come from `explainFatigueFactors`: neutral wording, no digits,
no raw scores. Each label compares the choice with the option the planner
would have picked without fatigue:
- a different employee → compared on their incoming history;
- a different code → compared on what each code alone adds.

The field is `[]` when fatigue did not change the choice. When fatigue is
off, the key is absent entirely.

### Tests

The new file is `tests/stage6-fatigue-wiring.test.ts`, with 33 tests.
Part 1's import-level guard in `tests/fatigue-model.test.ts` ("nothing
imports the fatigue model") no longer holds by design. It was replaced by
a narrower guard: the model is consumed only by the five gated planner
modules, none of which imports the global switch.

The new behavioural regression guard runs Stage 6, the top-up, the
foreign roster, `scoreCandidates` and the full seed pipeline in both
regimes. It checks their output fingerprints against values captured from
commit `37f70c4`, the last commit before wiring. They match byte for byte
both with no fatigue argument and with fatigue arguments passed but
disabled.

Tests went from 494 to 527, all passing. `npm run build` is clean.

## 2026-09-25 addendum: hard-constraints milestone, PHASE 1 of 3 — hard 5-consecutive-work-day cap and hard single-week hours cap

> **This phase is NOT the complete milestone.** It makes two new rules
> genuinely hard (never violated) using the same naive pre-scoring filter
> the 15h rest rule already uses. That filter can — and on real data does —
> leave coverage gaps and roster-shape problems that a smarter
> cross-employee reallocation would avoid. **Phase 2 (a cross-employee
> repair/reallocation pass) is still required** before these caps can be
> considered production-quality; concrete scenarios for it are listed at
> the end of this section.

### The two new hard caps

Both apply to every generation-driven population: the flexible General T1
pool (Stage 6 and its Stage-6.5 top-up), Profiling/Mesure, and every
foreign-company team (flight days and roster top-up).

1. **No more than `Config.max_consecutive_work_days` (default 5)
   consecutive calendar work days.** Counted continuously across the
   Monday boundary from real predecessor-plan history (see continuity
   below).
2. **No more than `Config.hard_weekly_hours_cap` (default 42) scheduled
   hours in one displayed Monday–Sunday window**, using the sum of
   `getShiftDurationHours` over that window's worked days.

The fixed JR→NT→OFF→OFF rotation (Transit/Leaders/Duty Officers) and every
other static team (Caisse/BCB, ...) is **exempt and untouched**. The
audited fixed cycle never exceeds 2 consecutive work days. Those teams
never pass through a generation gate. `tests/hard-work-caps.test.ts`
proves their roster is byte-identical to the pre-phase output.

### Mechanism: the rest rule's own gates, not a new legality layer

Each cap is an extra exclusion condition in the **same** filter that
already removes rest-illegal candidates. An excluded candidate is never
scored and never assigned. There is no post-hoc repair or drop pass, and
no parallel legality mechanism.

| Path | Gate | Running state |
|---|---|---|
| Stage 6 (`generateFlexiblePoolShifts`) | `legalCodesByEmployee` | streak from `runShiftGenerationPass`; hours = existing `hoursSoFarThisWeek` |
| Stage-6.5 / foreign top-up (`computeEmployeeDayCountTopUp`) | `legalCodesAt` (so the walk, the backtracking search, the neighbour preference and pass 2 only see cap-legal codes) | run length through the day, joining both sides plus the incoming streak; hours = `initialScheduledHours` + days added |
| Profiling/Mesure, foreign flight days (`assignPoolToWindow`) | `selectCompatibleShiftCodes` (new optional `hardCapFilter`) | per-team streak map; hours = existing `usageHours` |

- Pure primitives live in `lib/planning/hard-work-caps.ts`:
  `nextConsecutiveWorkDayStreak`, `wouldExceedConsecutiveDayCap`,
  `wouldExceedHardWeeklyHoursCap`, `consecutiveRunLengthIfWorked` and
  `resolveHardWorkCaps`.
- The streak counter is **always on**. It uses the same semantics as
  `FatigueState.consecutiveWorkDays`, but never routes through the fatigue
  model or `FATIGUE_MODEL_ENABLED`.
- The soft tie-break role of `hoursSoFarThisWeek` and `usageHours` is
  unchanged. The hard comparison was added only at the filter stage.
- `resolveHardWorkCaps` falls back to the defaults for an old
  `config_snapshot` that lacks the new fields. It never silently disables
  a cap.

### The new config field, and why it is NOT `maximum_average_weekly_working_hours`

`maximum_average_weekly_working_hours` (42) is a confirmed **average** over
a reference period that is still unconfirmed (`null`). A hard single-week
42h gate built on that field used to exist in this pipeline. It was
**removed on purpose**; see `generate-draft-plan.ts`, "IMPORTANT — no
calendar-week 42h gate". `hard_weekly_hours_cap` is a **separate, newly
introduced management rule** that happens to default to the same number.

The two fields stay structurally independent:

- `hard_weekly_hours_cap` has its own constant
  (`DEFAULT_HARD_WEEKLY_HOURS_CAP`). `lib/seed-data.ts` never derives it
  from the labor-rule average.
- Nothing in generation reads `maximum_average_weekly_working_hours`. A
  test moves it to 10 and to 99 and checks that the demo roster does not
  change.
- `average-hours.ts` and `auditAverageWeeklyHoursFeasibility` never read
  the hard cap. Both still report `not_evaluable` / no findings.
  `tests/labor-rule-invariants.test.ts` is unchanged and passes.

### Cross-week continuity of the consecutive-day count, and the honest "unknown"

`lib/planning/consecutive-days-continuity.ts` mirrors
`fatigue-continuity.ts`'s three-way split. It reads the same
`rotation-context.ts` primitives rather than duplicating them.

- **`prior_plan`**: the streak is counted backwards from the real
  predecessor plan's roster. `lowerBound` is set if that whole week was
  worked, because only one week back is read.
- **`fallback_static_baseline`** (approximate): this applies only where a
  static baseline is authoritative, i.e. static and fixed teams.
- **`unknown`**: this covers three cases. There is no context at all, the
  employee is absent from the predecessor plan, or the employee is
  demand-driven and only a static baseline exists.

`weekly-plan-service.ts` now fetches the predecessor plan's full roster.
It already did this for the rest boundary. `buildDraftPlanBundle` derives
a seed for every employee and passes it to `generateDraftWeeklyPlan` via
`planningOptions.incomingConsecutiveWorkDays`.

**Policy for `unknown`** (`incomingStreakForHardCap`): the count starts at
0 at generation time. The plan then **must** carry one visible,
non-blocking `consecutive_work_history_unknown` Plan Warning, which says
the streak before this week cannot be seen. The warning is shown in the
summary bar and drill-down as "Consecutive-day history unknown (info)".

Tradeoff, stated plainly: 0 means "no work ATLAS knows of", not "rested".
The more conservative alternatives were rejected:

- Assuming the cap is already reached would forbid Monday for the whole
  workforce on a first-ever week. That is a fabricated gap.
- Assuming "this week wraps onto itself" is a hypothesis this codebase
  already refuses to enforce as a hard rule for demand-driven staff (see
  `cross_week_continuity_uncertain`).

The uncertainty is therefore limited to the first days of a week with no
predecessor. It is disclosed, and it disappears once the preceding plan
exists. Within the displayed week the count is always exact.

### How gaps are reported (existing mechanisms only)

- **Stage 6**: an uncovered need stays uncovered. It surfaces as Stage 9's
  ordinary `unfilled_duty`, the same path a rest-driven shortfall takes.
- **Profiling/Mesure and foreign flight days**: these use the existing
  `DemandConflict` and its `"BLOCKING: ..."` `ConfigurationIssue`. When a
  cap excluded an otherwise rested, compatible member, the same issue
  names them and the cap involved (new optional `DemandConflict.capExcluded`).
  A conflict with no cap involvement keeps its original wording byte for
  byte.
- **Top-up (roster shape, not flight demand)**: one non-blocking
  `hard-cap-roster-top-up-shortfall` configuration issue per run. When the
  hours cap cannot hold the 5-day target at the shortest catalog code, the
  issue states that arithmetic explicitly.
- **Transparency**: `DraftWeeklyPlan.hardCapExclusions` lists every
  employee-day a cap removed although a rest-legal code existed. This is
  not a gap list.
- **Top-up tie-break**: once a cap has actually bound, the top-up's bounded
  search prefers, among equally large partial assignments, one that keeps
  OFF blocks within `max_consecutive_off_days`. It is a pure tie-break,
  inert when the caps do not bind. Without it, a cap-limited 4-work-day
  week put all 3 OFF days together. On the seed week this cut the new
  `consecutive_off_violation`s from +79 to +3.

### Measured impact on the seed data (default caps)

**The 42h default and the confirmed "5 WORK + 2 OFF" target are
arithmetically incompatible.** The shortest non-overnight catalog code is
NR01: 8.75h before 2026-09-20 and 9h after. Five of them come to 43.75h or
45h, both above 42h. So with the default hard cap, **no generation-driven
employee can be rostered 5 days in any week**. They get at most 4. This is
reported on every run as the structural top-up-shortfall issue. It is a
policy decision for RAM Handling, not something phase 2 can solve. Options
include a different cap value, a shorter code, or accepting 4-day weeks.

| Seed week | Caps | Generation-driven work days | `unfilled_duty` | BLOCKING | `consecutive_off_violation` | `separated_off_days` |
|---|---|---|---|---|---|---|
| 2026-08-31 | non-binding (999) | 817 | 0 | 0 | 16 | 3 |
| 2026-08-31 | default | 669 | 0 | 0 | 19 | 0 |
| 2026-09-21 regime | non-binding (999) | 817 | 0 | 0 | 16 | 2 |
| 2026-09-21 regime | default | 661 | 1 | 1 | 17 | 0 |

Additional results:

- The 5-consecutive-day cap alone changes one employee-day on seed data:
  `youssef-el-amrani`'s documented 7-day/63h week. The 42h cap drives the
  rest of the change.
- With both caps non-binding, the demo roster and every duty are
  byte-identical to the pre-phase output (fixture
  `tests/fixtures/pre-hard-caps-demo-plan.json`).
- The new 2026-09-21 gap is **Gulf Air, Sunday**. Under the GMT regime the
  only codes that cover its 04:30 window are MT02 (11.25h) and JR02 (13h).
  The 8-person team is fully needed on each of its 4 flight days, and
  3 × 11.25h = 33.75h leaves no room for a fourth 11.25h shift under 42h.
  The whole team is excluded on Sunday, which produces a BLOCKING conflict
  naming all 8 members plus an `unfilled_duty`. This gap is structural:
  it is unavoidable within the week at 42h.

### Concrete PHASE-2 scenarios (avoidable gaps the naive filter creates)

All of these are pinned in `tests/hard-work-caps.test.ts` under "PHASE-2
SCENARIOS":

1. **Foreign company, streak-blind ordering.** Air France has 5 members and
   headcount 3. `af-1`..`af-3` arrive on day 4 of a streak; `af-4` and
   `af-5` arrive fresh. Least-used-first gives Monday to `af-1..3`. On
   Tuesday all three are at the cap, so Tuesday is one person short
   (BLOCKING, `capExcluded` = af-1..3). A streak-aware allocation (Monday:
   af-4, af-5 and one of af-1..3) covers every day. The test checks this
   by construction.
2. **Profiling, the same front-loading.** `p-tired` arrives on day 4 and
   `p-fresh` arrives fresh. Monday needs 1 and Tuesday needs 2. Monday's
   tie goes to `p-tired` by pool order, so Tuesday is short. Giving Monday
   to `p-fresh` covers both days.
3. **Stage 6 front-loading, real demo data.** `youssef-el-amrani` is
   rostered Monday–Thursday on MT01, 36h. The 42h cap then closes
   Friday–Sunday. The result is a 3-day OFF block, flagged as a
   `consecutive_off_violation`, which spreading the same 4 days would
   avoid. The greedy has no lookahead for the week's remaining hours or
   streak budget.

Phase 2's job is to repair these using cross-employee swaps and
reallocation while keeping every hard rule: 15h rest, both new caps and
the OFF-day rules. It must not relax any of them.

## 2026-09-25 addendum: hard-constraints milestone, PHASE 2 of 3 — cap-aware roster target and bounded cross-employee repair

> **Phase 2 has landed.** The "Phase 2 is still required" warning at the top
> of the phase-1 section above is kept as the historical record. The
> cross-employee repair pass it asked for now exists, together with the
> product owner's resolution of the 42h-vs-5-days conflict. It is a
> **bounded, one-hand-off repair, not a universal solver**. Structural
> shortfalls such as Gulf Air's are still reported as honest BLOCKING gaps
> (see "What it cannot do" below).

### Part A — the cap-aware per-employee roster target

**Resolution (product owner).** The 42h hard weekly cap stands. A "normal"
week now means as many work days as legally fit, up to 5, under both hard
caps and given the employee's real shift codes. If the hours cap forces a
week down to 4 work days and 3 OFF, that week is **normal**. It is not an
anomaly.

**Heuristic** (`lib/planning/roster-target.ts`, `computeCapAwareTargetWorkDays`).
It is deterministic and documented, but it is not a global optimum.

- Start with the employee's **committed** days: Stage-6 days for the
  flexible pool, flight days for a foreign-company member. Count them with
  their real, date-resolved hours.
- Add free days one at a time, cheapest first. Each free day costs the
  shortest non-overnight catalog code effective on its real date
  (`shiftCatalogForDate`). That is 9h after 2026-09-20 and 8.75h before.
  Stop when the next day would break the cap or the normal target is
  reached.
- If the cap never binds, the target is the normal 5, exactly the old fixed
  number. Caps-off plans are therefore unchanged.

Known simplifications:

- A committed demand code counts at its real length, even when it is long.
  Stage 6 spending hours on a long demand code is treated as
  demand-justified, not as an artifact.
- The target models hours only. It ignores the consecutive-day cap, 15h
  rest and qualifications for top-up days.

**Where the target is used:**

- **Stage-6.5 and foreign top-ups** now aim at each employee's own target
  instead of `daysOrder.length - normal_weekly_off_days`
  (`computeFlexibleEmployeeTopUp`, `generateForeignCompanyShifts`).
- **Top-up search.** With a lowered target, the week has more OFF days than
  `max_consecutive_off_days` can hold in one block. The bounded search
  therefore prefers a target-reaching assignment whose OFF blocks respect
  that rule. If needed it runs a second search that also uses the reserved
  OFF pair, with a fresh budget of 500 nodes. With the normal target this
  never changes anything: two OFF days always fit the rule.
- **Preferred OFF window length** (`preferredOffWindowLength`). This is
  still 2 with today's confirmed 2 / 2 rules, but it is now derived from
  the target rather than assumed.
- **Validation** (`lib/planning/validation.ts`):
  - If a week meets its own lowered target, `checkSeparatedOffDays` does
    not apply. Where 3 OFF days fall is largely set by committed days, and
    they cannot form one block legally.
  - The phase-1 `hard-cap-roster-top-up-shortfall` note now counts only
    employees below their **own** target. On both seed weeks it no longer
    fires.
  - There is a new non-blocking **`roster_target_shortfall`**. It fires when
    an employee is rostered fewer days than their own target **and** a hard
    cap closed a free day the hours arithmetic had room for. A shortfall
    with no cap involvement (15h rest) predates this milestone and is not
    re-flagged, so caps-off plans get no new warning.
- **Transparency:** `DraftWeeklyPlan.rosterTargets` lists each target with
  its arithmetic (`committedHours`, `assumedFreeDayHours`, `capLimited`,
  `capClosedFreeDays`).

**Normal versus flagged.** This distinction is the crux of Part A.

- *4 worked, target 4* (the cap cannot fit a 5th day): normal. Nothing is
  flagged.
- *4 worked, target 5, and a cap closed a day* (for example the
  consecutive-day cap closed a day the hours cap allowed): flagged as
  `roster_target_shortfall`.

Both cases are pinned in `tests/hard-work-caps.test.ts`, under "PHASE 2,
part A".

### Part B — the bounded cross-employee repair pass

`lib/planning/hard-cap-repair.ts` runs **after** each population's greedy
generation and **before** its shortfalls are finalized:

- **Flexible pool:** runs on Stage 6's rest-enforced result, before the
  top-up (`repairFlexiblePoolWeek`).
- **Profiling/Mesure:** runs per team, after the day loop.
- **Foreign company:** runs per company on the flight-day roster, before
  the roster top-up.

It runs only when the greedy recorded a hard-cap exclusion **and** left
something to repair. Otherwise nothing is called, and the output is
byte-identical to phase 1's.

**The move: a one-step hand-off.** Employee X is blocked by a hard cap, not
by rest or qualification, from covering a need on day u. X works some other
day d. An eligible employee Y who is OFF on d takes X's day-d work, which
frees X to cover day u. Day d's coverage is unchanged because Y fills the
same slot. Day u gains a person. Nobody else's roster changes.

**Flexible pool specifics:**

- Gaps are measured by replaying Stage 6's own coverage accounting
  (`replayStage6HardCoverage`).
- Y must hold every role X's shift was counted for. After the move, no
  (bucket, role) unit may be less covered than before.
- **OFF-run dead-ends**, such as the youssef case, get two moves, tried in
  this order:
  - **(a) Shift own day.** X moves one of their own Stage-6 days to a free
    day. Nobody else is touched.
  - **(b) Hand-off with a re-simulated top-up.** The top-up is re-run using
    the exact same function.
  - Either move is kept only if X's OFF blocks then respect
    `max_consecutive_off_days`, nobody newly breaks that rule, and nobody
    loses a rostered day.
- **The one coverage relaxation.** Stage 6 also counts Profiling/Mesure
  demand, which the dedicated team generates independently. A Profiling or
  Mesure unit on a day that team fully covers (no BLOCKING conflict that
  day) is not treated as a real gap. A move may leave such a unit to the
  dedicated team. This is why Profiling/Mesure generation now runs before
  the flexible repair. It never depended on Stage 6, and its exclusions and
  repairs are still listed in their original population order.

**Hard constraints are never relaxed.** Every candidate move is checked on
the **whole resulting week** of both X and Y:

- 15h rest against both neighbours of each changed day. This includes the
  real prior-week boundary on day 1 and the same-week Sunday↔Monday wrap
  for a 7-day window.
- The consecutive-day cap, counted from the real incoming streak.
- The weekly hours cap.
- The need's own qualification, role split and window compatibility. The
  greedy's own `selectCompatibleShiftCodes` ranking and Stage-6 skill rules
  are reused.

Fixed-cycle and static employees are never in any population the pass
receives.

**Determinism.** Every choice iterates an explicitly sorted list:

- gaps by day index, then need order;
- blocked employees X by id;
- X's days by day index;
- stand-ins Y by hours already rostered, then id;
- codes by the generator's own ranking.

No decision depends on Map or Set iteration order. A test feeds the same
pre-repair week with the pool listed in two different orders and gets
byte-identical output.

**Bound.** `HARD_CAP_REPAIR_ATTEMPT_BUDGET = 2000` candidate evaluations per
population, per team, per week. This mirrors
`TOP_UP_SEARCH_NODE_BUDGET = 500`. Termination holds on two counts:

- Failed evaluations are capped by the budget.
- Every *applied* move strictly reduces the total shortfall, or removes one
  OFF-rule breach while creating none. The number of applied moves is
  therefore finite too.

Moves are applied atomically after full verification. An exhausted budget
leaves the last fully legal state, never a half-applied move. The remaining
gap is then reported as in phase 1.

A pathological test illustrates the budget. It has 41 blocked members,
5 hand-off days each and 40 stand-ins who all fail at the last check. An
unbounded search would make 8,405 evaluations and find nothing. The test
stops at 2,000 with `budgetExhausted: true` and unchanged output.

**Explainability.**

- `DraftWeeklyPlan.hardCapRepairs` lists every applied move: kind, the two
  days, who gave and who took, codes, the cap involved, and a plain-language
  explanation.
- The same text is set as `hardCapRepairReason` on each affected
  assignment. The key is absent everywhere else.
- `hardCapExclusions` remains the record of what the greedy filters
  excluded at generation time.
- An unresolved cap-involved conflict carries `capRepair`: attempts used,
  budget, and whether it was exhausted. Its BLOCKING text now says the
  bounded repair pass ran and found no legal reallocation. Before, it said
  "not implemented yet".

### Results

**The three phase-1 scenarios** (`tests/hard-work-caps.test.ts`, "PHASE 2,
part B"):

1. **Profiling.** Monday moves from `p-tired` to `p-fresh`, and `p-tired`
   covers Tuesday. Coverage is full and neither cap is broken.
2. **Air France.** Monday moves from `af-1` to `af-4`, and `af-1` covers
   Tuesday. Every flight day has 3 people and nobody works more than
   5 days in a row. **Honest finding:** the exact phase-1 fixture is
   *infeasible* under the full 42h default. Every code covering the
   07:40–12:10 window is 9h, so each member can work at most 4 days, and
   5 × 4 = 20 is less than the 21 slots needed. The consecutive-day
   ordering gap that the scenario pins is therefore shown with the hours cap
   non-binding. Under the full default caps the repair searches, finds no
   legal move and leaves the Tuesday gap reported. That is correct.
3. **youssef-el-amrani (real demo data).** His Monday moves to Saturday by
   move (a). He goes from Mon–Thu worked with Fri–Sun OFF to Tue, Wed, Thu
   and Sat worked. He still works 4 days and 36h, and he no longer has a
   `consecutive_off_violation`. Monday's Profiling demand is still covered
   by the dedicated Profiling team, with no BLOCKING conflict and no
   unfilled duty.

A new flexible-pool Stage-6 gap scenario is also pinned and resolved. Two
tired ACEs hand Monday to two fresh ones and cover Tuesday's Gate and
Boarding.

**Gulf Air** is still unresolved, correctly. The whole 8-person team is
needed on each of its 4 flight days, and 3 × 11.25h + 11.25h exceeds 42h
for everyone. No member is OFF on any flight day, so no hand-off exists.
Sunday remains BLOCKING, naming all 8 members. This is covered by a
fixture test and by the real 2026-09-21 week.

**Seed data** (default caps, measured after phase 2):

| Seed week | Configuration | Generation-driven work days | `unfilled_duty` | BLOCKING | `consecutive_off_violation` | `separated_off_days` | `roster_target_shortfall` | repairs |
|---|---|---|---|---|---|---|---|---|
| 2026-08-31 | caps non-binding | 817 | 0 | 0 | 16 | 3 | 0 | 0 |
| 2026-08-31 | default, repair off (Part A only) | 669 | 0 | 0 | 17 | 0 | 0 | 0 |
| 2026-08-31 | default | 669 | 0 | 0 | **16** | 0 | 0 | 1 |
| 2026-09-21 | caps non-binding | 817 | 0 | 0 | 16 | 2 | 0 | 0 |
| 2026-09-21 | default | 661 | 1 | 1 (Gulf Air Sunday) | **16** | 0 | 0 | 1 |

With the default caps, the plan no longer adds a single
`consecutive_off_violation` over the caps-off baseline. Phase 1 added 3.
The same 16 pre-existing violations (Chafik employees) remain. Draft
generation on the seed week still takes well under a second.

### What it cannot do (known limitations, stated plainly)

- **Only one hand-off per move.** Y cannot, in turn, hand one of their own
  days to a Z. A gap that needs a longer chain is reported as before.
- **No moves across populations.** For example, a foreign-company member
  never takes a flexible-pool day.
- **No new capacity.** When the team is too small, or its commitments too
  long for the cap, the gap is structural. Gulf Air and the full-caps Air
  France fixture are examples.
- **Flexible gap detection uses Stage 6's own accounting**, replayed, not
  Stage 9's final duty assignment. It targets exactly the units Stage 6
  left uncovered. The final `unfilled_duty` from Stage 9 remains the
  authority.
- **OFF-run repair covers the flexible pool only.** Profiling/Mesure have no
  roster target, and foreign-company OFF shapes are dictated by flight
  days.
- **The roster target models hours only.** See Part A above.
- **The roster target of a flexible employee is fixed after Stage 6.** It
  treats the employee's Stage-6 codes as committed, even when a shorter
  demand code might have left room for another day.

**Phase 3** of the milestone is not part of this change.
