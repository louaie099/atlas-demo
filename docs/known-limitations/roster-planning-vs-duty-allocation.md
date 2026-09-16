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

## Sequencing

1. Multi-week Flight Program / Import Flights (in progress) — unaffected by
   this document, proceed unchanged.
2. Confirm the real RAM Handling working-hours/roster obligation with
   management — not something ATLAS or this document should guess.
3. Redesign roster generation (Stage 6) against the confirmed obligation,
   jointly with everything listed above.
