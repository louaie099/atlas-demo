# Known limitations: Labor Rules v2 (2026-10-20)

**Status: implemented and tested, with the specific scope limits below.**
Recorded here (referenced by `lib/break-policy.ts`'s own doc comment) so the
exact boundary of what this milestone enforces — vs. what it only detects,
vs. what remains a genuinely open policy decision — survives independently
of any one conversation or commit.

## What is CONFIRMED vs. PROTOTYPE in this milestone

Every new field added by this milestone (`lib/labor-rules.ts`'s
`minimumWeeklyPaidHours`, `maximumWeeklyPaidHours`, `minimumMonthlyPaidHours`,
`maximumMonthlyPaidHours`, `maxContinuousShiftHours`, `maxConsecutiveNightShifts`,
`maxRestIntervalHours`, and the whole `BreakPolicy` in `lib/break-policy.ts`)
starts as `{ value: null, source: "unconfirmed_prototype" }` — a real,
evaluable mechanism exists, but no real RAM Handling number has been
confirmed for any of them. Nothing here was invented to fill that gap:
every one of these stays inert (never excludes a candidate, never flags a
plan, never deducts a break) until an administrator configures a real
value through the Planning Rules drawer. `maxRestIntervalHours` additionally
stays **disabled by default** even once a number is configured — see its own
dedicated section below.

The one exception, `maximumAverageWeeklyWorkingHours` (pre-existing, not
part of this milestone), remains a confirmed PRINCIPLE whose reference
period is still unconfirmed — unrelated to the new
`maximumWeeklyPaidHours`/`minimumWeeklyPaidHours` pair, which are evaluated
directly against one real displayed week's own paid-hours total and need no
reference period at all.

## Scheduled span vs. paid hours (Option C)

`lib/planning/paid-hours.ts` keeps these two numbers permanently distinct:
**scheduled span** (raw entrée→sortie elapsed time, never reduced by a
break — used for `maxContinuousShiftHours`, rest, and all fatigue/recovery
math) and **paid hours** (scheduled span minus an unpaid-break deduction,
applied only when `BreakPolicy.enabled` and the shift qualifies — used ONLY
for the weekly/monthly paid-hour ceilings and floors). Every UI and
validation message that surfaces `paidHours` is labeled `provisional` for as
long as `breakPolicy.source === "unconfirmed_prototype"` (today, always) —
never presented as a verified contractual number.

## Enforcement scope: prevention (Stage 6 only) vs. detection (everywhere)

The two new HARD per-shift caps — `maxContinuousShiftHours` and
`maxConsecutiveNightShifts` — are wired as pre-scoring PREVENTION filters
(`lib/planning/hard-work-caps.ts`'s `wouldExceedShiftDurationCap` /
`wouldExceedConsecutiveNightShiftCap`) into exactly one gate:
`lib/planning/shift-generation.ts`'s Stage 6 flexible General T1 pool — the
same gate the pre-existing consecutive-work-day cap already sits at. They
are **NOT YET** wired into:

- the Stage-6.5 roster top-up (`lib/planning/roster-generation.ts`),
- Profiling/Mesure generation (`lib/planning/specialized-team-generation.ts`),
- foreign-company generation (`lib/foreign-shift-planning.ts`'s
  `selectCompatibleShiftCodes`).

So a candidate shift that would breach either cap can still be assigned by
those three paths. `lib/planning/validation.ts`'s
`checkMaxContinuousShiftDuration` / `checkMaxConsecutiveNightShifts` run as a
plan-level BACKSTOP over every employee regardless of which population
generated their roster, so a breach from any of the three un-wired paths is
always still DETECTED and reported as a HARD `PlanIssue` — it is simply not
PREVENTED from being generated in the first place outside Stage 6. The same
split (and the same honest "detection everywhere, prevention only in Stage
6" framing) already existed for the pre-existing consecutive-work-day cap
before this milestone; nothing here narrows that further.

`checkWeeklyPaidHours` (the weekly/monthly paid-hours floor/ceiling check)
has no Stage-6 prevention counterpart at all in this milestone — it is
DETECTION-only everywhere, for every population, from day one. A
configuration that makes a compliant roster structurally impossible is
instead caught earlier, at SAVE time, by
`lib/planning/labor-rule-feasibility.ts`'s `auditLaborRuleConfigurationFeasibility`
(see its own section below) — a different mechanism, checking a different
kind of impossibility (the configured numbers alone, vs. one real plan's
real data).

## No cross-week night-shift-streak continuity

`lib/planning/generate-draft-plan.ts`'s `nightStreakEnteringDay` map is
always seeded to 0 at the start of a displayed week's generation — unlike
the pre-existing consecutive-work-day streak
(`streakEnteringDay`/`incomingStreakByEmployee`), which threads real
cross-week context from the prior week's actual roster.
`maxConsecutiveNightShifts` is therefore only ever enforced (both in Stage
6's prevention filter and in validation.ts's backstop) **within a single
displayed week** — an employee who worked 2 consecutive night shifts ending
the prior week and is then assigned more at the start of the next displayed
week will not have that streak detected as continuing. The same gap applies
to `lib/planning/fatigue-repair.ts`'s own legality checks (see below):
`incomingNightShiftStreak` is an optional caller-supplied input defaulting
to 0, not something the repair pass derives itself.

## `maxRestIntervalHours`: disabled by default, not yet wired at all

Per Moses's explicit instruction, `maxRestIntervalHours` stays **disabled by
default** even once an administrator configures a number for it — and
unlike the other new fields, no enforcement mechanism (neither a Stage-6
prevention filter nor a validation.ts backstop) has been wired for it in
this milestone at all. Configuring a value today has zero effect on
generation or validation; it is a confirmed PRINCIPLE field, no more, held
in reserve for a future phase that both confirms the real policy and
implements its enforcement.

## The monthly-hours evaluator's wiring status

`lib/planning/monthly-hours.ts`'s `loadMonthlyHoursForEmployee` /
`computeMonthlyHoursForEmployee` is a complete, tested, standalone
aggregator — it correctly sums real per-week roster data across a calendar
month's overlapping ISO weeks (reusing `weeksOverlappingMonth`, never
joining across weeks at the query level) and reports `no_data` /
`partial_coverage` / `evaluable` honestly depending on how much of the month
actually has a saved weekly plan. It is **not yet called from any UI or API
route** — there is no "Monthly Planning" page or endpoint in this
milestone that surfaces a real employee's real monthly total. It exists so
a future phase can wire it in directly rather than re-deriving the same
month-boundary-safe aggregation logic.

## The configuration-feasibility audit's scope

`lib/planning/labor-rule-feasibility.ts`'s
`auditLaborRuleConfigurationFeasibility` is deliberately conservative: it
only flags a combination of configured numbers that is arithmetically
impossible for EVERY employee under EVERY legal shift code (a trivial
min > max contradiction, a continuous-shift-duration ceiling below every
catalog shift's own span, or a minimum-weekly-paid-hours floor above what
even the longest shift across the maximum legal work days could reach). It
never flags a merely tight-but-achievable combination, and it is NOT a real
per-employee, per-population feasibility check (it does not know which
codes a specific employee is actually eligible for) — a genuine per-employee
infeasibility is still only caught the honest way, by `validation.ts`'s
plan-level checks reporting the specific week they could not satisfy.

## The fatigue repair pass (`lib/planning/fatigue-repair.ts`)

**Disabled by default, never wired into any generation pipeline.**
`repairRosterFatigue` is a standalone, explicitly-invoked utility — it is a
no-op unless BOTH a caller runs it AND the `FatigueConfig` passed to it has
`enabled: true` (the global default, `FATIGUE_MODEL_ENABLED`, stays
`false`). Nothing in Stage 6, the top-up, Profiling/Mesure, or
foreign-company generation calls it today.

Its scope is deliberately narrow — one move type only: a SAME-CODE,
two-employee, two-day swap (two people trade which of two days each works
an identical shift code they already both hold elsewhere in their own
week). This is coverage-preserving (the same code covers the same day,
just by a different qualified person) and hours/weekly-cap-preserving (each
employee keeps the exact same multiset of codes across their week, just
reordered) by construction, which is what lets it skip re-checking
`maximumWeeklyPaidHours`/`minimumWeeklyPaidHours`/the consecutive-work-day
COUNT entirely — only position-sensitive legality (15h rest, the two new
hard caps, and the weekly OFF-day hard rules) is re-verified per candidate,
reusing `lib/planning/hard-cap-repair.ts`'s own `restLegalAt`/`hardCapBreach`/
`breaksOffDayRules` primitives rather than re-implementing them.

What it deliberately does NOT do: `hard-cap-repair.ts`'s general
"ejection chain" hand-off (a move between two DIFFERENT codes, trading net
headroom between two employees) or any multi-day chain. A broader
fatigue-driven reallocation along those lines is a larger, separate
exercise outside this milestone's scope. It also inherits the cross-week
night-streak gap described above, and accepts `incomingWorkDayStreak` /
`incomingNightShiftStreak` / `priorWeekBoundaryContext` as optional,
caller-supplied inputs (defaulting to "nothing known") rather than deriving
real cross-week context itself — a caller with that real context (the same
kind `hard-cap-repair.ts` itself threads through) should supply it.

## Remaining policy decisions still needed from RAM Handling

None of the following were invented, and none should be, by this
implementation:

- A real unpaid-break policy (minutes per shift, minimum shift length it
  applies from) to replace `DEFAULT_BREAK_POLICY`'s disabled/null
  prototype.
- Real weekly and/or monthly minimum/maximum PAID-hour targets.
- A real maximum continuous shift duration and maximum consecutive
  night-shift count.
- Confirmation of whether `maxRestIntervalHours` is a real RAM Handling
  policy at all, and if so, its real value and intended enforcement
  mechanism (this milestone only reserves the field).
- The still-outstanding reference period for the pre-existing
  `maximumAverageWeeklyWorkingHours` principle (unrelated to this
  milestone, carried over unresolved).
