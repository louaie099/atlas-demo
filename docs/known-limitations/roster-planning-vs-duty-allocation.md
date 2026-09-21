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
