# ATLAS — Handoff Document

Prepared to let a fresh session continue without rediscovering the repo. No behavioral code was changed while preparing this — documentation only.

## 1. Product purpose

ATLAS is an airport workforce + operations platform for RAM Handling (ground handling at Casablanca Mohammed V, CMN). It converts a flight program into a workforce plan (Weekly Planning), then supports live operational changes against that published baseline (Real-Time Operations), tracks employees (Workforce Intelligence), and preserves an audit trail (Planned → Modified → Actual). Built solo by Moses, an airport Check-in/Boarding agent, with commercial ambitions.

Five architectural domains (only Weekly Planning has real depth today):
1. **Weekly Planning** — flight program → workforce baseline. This is essentially all that's built.
2. **Real-Time Operations** — `app/operations`, `app/api/live-ops`, `/confirm-reassignment`, `/simulate-delay`. Thin/prototype, hardcoded to one demo flight (`at201`), not touched by any recent work.
3. **Employees / Workforce Intelligence** — `app/employees`, `/api/employees`. Permanent facts only; no derived statistics (planned vs actual hours, fairness history) exist yet — intentionally deferred, see §12.
4. **Operational Configuration** — flat, not yet effective-dated/versioned (`lib/operation-rules.ts`, `lib/labor-rules.ts`, `lib/ram-staffing-matrix.ts`, `lib/company-config.ts`, `lib/destination-classification.ts`).
5. **Audit/History** — `app/audit`, `/api/audit-log`, `assignment_modifications` table. Only the manual "Find Agent" assign path writes structured modification records; live reassignment/delay paths only write narrative `audit_log_entries` — a known gap, not touched recently.

## 2. Repo / stack

- GitHub: `louaie099/atlas-demo` (main branch) — **the active repo**. `louaie099/atlas-mvp` is an earlier, separate, unrelated scaffold — never use it.
- Deployed: `https://atlas-demo-kappa.vercel.app` (Vercel, auto-deploys on push to `main`).
- Supabase project ref: `grpzghldqbeimbsoaike`. No RLS, no auth, no multi-tenancy (confirmed in repo README) — service-role key used server-side throughout (`lib/supabase-server.ts`).
- Next.js App Router, TypeScript, Supabase (Postgres), Vitest, Tailwind.
- I (Claude) have no push access to GitHub and no direct DB/SQL access to Supabase. My workflow every time: make changes locally in a sandbox clone → commit → `git format-patch` → hand the user a `.patch` file → they run `git am` + `git push` themselves → they separately run any new migration SQL by pasting it into the Supabase SQL Editor (migrations are **never** auto-applied by the Vercel deploy). Always verify what's actually live via the deployed URL, not by assuming a push happened.

## 3. Database / migrations

`supabase/migrations/0001` through `0013`, applied in order. Most recent and relevant:
- **`0009_weekly_plan_lifecycle.sql`** — `weekly_plans` gains `status` (draft/published), `revision`, `generated_from_hash`, `config_snapshot`, `issues`, `configuration_issues`. `assignment_modifications` table (structured Planned→Modified history, `plan_id`/`plan_revision`/`previous_employee_id`/`new_employee_id`).
- **`0013_flight_date_week_scoping.sql`** — added `flights.flight_date` (real operating date, authoritative) and `flights.week_start` (Monday grouping key, always derived FROM flight_date, never independently reasoned about), backfilled existing rows, added CHECK constraint `flights_date_matches_day_of_week` (flight_date's real weekday must equal the stored `day_of_week` label) and unique constraint `flights_date_number_unique (flight_date, flight_number)`. **This migration has been run by the user and is live.**

No other schema changes pending. `staffing_requirements` has no `week_start` column — it's scoped by joining through `flight_id` to `flights`.

## 4. Domain rules / confirmed constraints (do not re-derive, do not weaken)

- **15h minimum rest is a hard, confirmed rule.** Never negotiable, never softened for coverage.
- **`config.maximum_average_weekly_working_hours = 42` is an AVERAGE ceiling over a still-unconfirmed reference period — it is explicitly NOT a per-employee target-hours floor, and must never be treated as a Monday–Sunday hard cap.** See `lib/planning/average-hours.ts`'s doc comment and `docs/known-limitations/roster-planning-vs-duty-allocation.md`.
- Gate/Boarding/Profiling/Mesure lead times: fixed_rule, T-60 standard aircraft, T-90 for Dreamliner (Boeing 787-9) — see `lib/planning/requirement-window.ts`.
- Check-in: `demand_forecast` source, default policy T-180 open / T-45 close before departure — `lib/planning/checkin-demand.ts`. **Prototype/unconfirmed coefficients, explicitly marked as such** — real RAM policy not yet provided.
- Foreign-company operations use their own model (`lib/foreign-company-window.ts`, `lib/company-config.ts`, `lib/foreign-shift-planning.ts`) — separate from RAM/General T1 logic, not touched by recent work.
- Real RAM Handling shift catalog only (`lib/shift-templates.ts`, `SHIFT_CODES`) — never invent a shift code. Overnight-wrapping codes (AP03/AP04/NT01/N8) are explicitly excluded from General T1's candidate set.
- Fixed/cyclic teams (Transit, Leaders, Duty Officers — `lib/fixed-cycle-rotation.ts`, `lib/teams.ts`'s `FIXED_CYCLE_TEAMS`) have a genuinely confirmed repeating rotation — different rules apply to them than to demand-driven populations (see §8's wraparound fix).

## 5. Weekly Planning lifecycle

`Select week → Flight Schedule (Add/Edit/Remove/Import) → Make Planning → Draft Weekly Plan → Review → Publish`.

- One `weekly_plans` row per week (`id = planIdForWeek(weekStart)`, deterministic). **Once published, a plan can never be regenerated** — `regenerateDraftPlan` hard-blocks on `status === "published"` (`lib/planning/weekly-plan-service.ts`). There is currently no path to create a "next revision cycle" for an already-published week — a known, accepted limitation, not a bug.
- Editing/adding/removing a flight never auto-regenerates a plan. Staleness is surfaced via `generated_from_hash` (a content hash of flights+employees+config at generation time) compared against the current inputs — see `isStale` in `app/api/planning/weekly-view/route.ts`. Shows a banner; never auto-triggers Make Planning.
- Single source of truth per page load: `GET /api/planning/weekly-view?week_start=...` returns `{weekStart, weekLabel, plan, isStale, flights, roster, schedule, issues, planIssueCount, configurationIssues}` in one call — Flight Coverage, Agent Schedule, and the summary bar (`components/planning-summary-bar.tsx`) all render from this one response, never independently re-fetched.
- `POST /api/planning/make-planning` takes `{week_start}` in the body (defaults to `CURRENT_WEEK_START` if omitted).

## 6. Planner stages and key implementation decisions

Pipeline: `flights + employees + config → weekly-requirements.ts (per-flight StaffingRequirement) → demand-aggregation.ts (30-min bucket demand per role) → Stage 6 (roster: who works, what shift) → Stage 9 (duty assignment: which real flight duty) → validation.ts → persistence`.

- **Stage 6 — General T1**: `lib/planning/shift-generation.ts`, `generateFlexiblePoolShifts`. A genuine joint bucket-level greedy set-cover solver (built in Priority 2, commit `25c7fe0`) — NOT a fixed role-order heuristic. Demand-driven: an employee not selected is genuinely OFF that day (no fallback to their static `weekly_shifts` template for this population).
- **Stage 6 — Profiling/Mesure/foreign**: `lib/planning/specialized-team-generation.ts`. Separate generation, same demand-driven philosophy, untouched by the General T1 rewrite except shared helper fixes.
- **`enforceRestInvariantAcrossWeek`** (`shift-generation.ts`) — the final whole-week hard rest safety net, run after Stage 6. Its cyclic Sunday→following-Monday wraparound check is now split by population (fix in `aaae266`): **hard drop for fixed/cyclic teams** (their repeat is confirmed), **kept + surfaced as the new `cross_week_continuity_uncertain` PlanIssueType (non-blocking warning) for demand-driven populations** (their "next week repeats" is an unconfirmed assumption) — see `lib/planning/validation.ts`'s `checkRestBetweenDays`.
- **Stage 9**: `lib/planning/duty-generation.ts`, `generateDutiesForDay`, using `lib/scoring.ts`'s `scoreCandidates`. Takes an `ActualRestHoursByEmployeeDay` map (the single authoritative rest source, fed from `enforceRestInvariantAcrossWeek`'s own real computation — fix in `68303c8`, replacing a stale static `employee.rest_before_shift_hours` field that used to gate eligibility incorrectly).
- **Stage 6/Stage 9 coherence** (commit `cc70251`) — see §8, the single most important recent architectural fix.

## 7. Final verified planner baseline

**257/257 required headcount positions filled = 100.0% coverage**, on the original seeded demo week, verified live after `cc70251` was deployed:
- Check-in 98/98, Gate 28/28, Boarding 28/28, Profiling 21/21, Mesure 32/32, Company Team 50/50.
- **0 overlapping duties, 0 unqualified duties, 0 duties on an OFF day, 0 real hard `rest_violation`, 0 blocking conflicts.**
- 151 `consecutive_off_violation` warnings and a known fairness outlier remain (§13) — these are the joint solver's own optimization limits, not hard-invariant violations, and were explicitly NOT chased further per the user's own instruction ("don't target 100% as a number — target Stage 6/Stage 9 consistency").
- This baseline predates the multi-week Flight Program work (`ad45042`/`45d7d6f`/`1f8312b`) and predates the `CURRENT_WEEK_START` correction — re-verify after the current task (§19) is deployed, since the demo week's actual date changed from Sep 1 to Aug 31 2026.

## 8. Stage 6/Stage 9 coherence fix — why it mattered

Live audit found AT870 (a 23:00 Dreamliner departure) with Gate+Boarding simultaneously at 0/2 or partial, despite Stage 6 believing it had secured enough shared, multi-qualified people. Root cause, fully traced and reproduced: **Stage 6 rostered the exact total headcount needed across roles sharing a scarce pool, but Stage 9 independently re-resolved the same pool in a different processing order (Check-in before Gate before Boarding), consuming the shared people for a different role than Stage 6 intended.** A fixed role-order change would only move the gap, not fix it (explicitly identified and rejected as a shortcut).

Real fix, two coordinated changes, same principle on both sides of the boundary:
1. `duty-generation.ts`: real per-flight requirements grouped into clusters of mutually-overlapping time windows; within each cluster, resolved **most-constrained-first** (fewest eligible candidates gets first claim), not by fixed departure-time order.
2. `shift-generation.ts`: Stage 6's own per-bucket role-credit changed from a fixed priority order (Boarding always first) to **scarcest-remaining-first** — whichever role has the smallest positive remaining need in that bucket gets the candidate's credit.

Verified: AT870 gaps resolved, zero regressions, reached the 257/257 baseline above.

## 9. Multi-week Flight Program architecture (in progress)

Design approved and implemented in two commits (`ad45042` backend, `45d7d6f` frontend), with a critical bug found afterward and fixed in `1f8312b` (not yet deployed — see §19).

- **`lib/flight-date.ts`** — single source of truth for ALL date math: `dayOfWeekFor`, `weekStartFor`, `weekDates`, `shiftWeek`, `weekLabelFor`, `flightDateFor`, `DAYS_ORDER`. Every other file must derive through this module, never restate date logic independently.
- `flights.flight_date` is authoritative; `week_start` is a pure grouping key derived from it.
- API: `GET/POST /api/flights` (week-scoped, real Add Flight — `app/api/flights/route.ts`), `PUT/DELETE /api/flights/[id]` (Edit/Remove), `POST /api/flights/import` + `/import/commit` (CSV preview → confirm, shared validation in `lib/flight-import.ts`'s `validateImportFile`/`validateRow`). None of these ever store a manually-entered staffing number — `destination_category`/`operator_type` are always derived (`classifyDestinationOperationally`, RAM-vs-foreign check).
- XLSX import deliberately deferred (CSV only) — avoided adding a parsing dependency mid-migration.
- Frontend: `app/planning/page.tsx` holds real `weekStart` state (bootstrapped from the server's own resolved value on first load, never a hardcoded client-side default), real Previous/Next Week (`components/week-nav.tsx` + `shiftWeek`), `components/add-flight-form.tsx`, `components/import-flights-dialog.tsx`, Edit/Remove wired into `components/flight-schedule-view.tsx`'s detail panel.
- `tests/multi-week-isolation.test.ts` proves two distinct weeks' flights/plans never leak into each other — this was a REAL bug found and fixed: `weekly-plan-service.ts` had three unscoped `flights` queries (`generateDraftPlan`, `regenerateDraftPlan`, `loadPersistedPlanView`) that would have caused complete cross-week corruption the moment a second week existed. All three are now scoped by `week_start`.

## 10. Key commits (chronological, most relevant first)

- `cc70251` — Stage 6/Stage 9 coherence fix (§8). **Deployed & verified live (257/257).**
- `aaae266` — cross-week wraparound rest conflict → visible warning for demand-driven populations, not silent hard drop. **Deployed.**
- `6565909` — AT870 bucket-coverage fix (shift ending mid-bucket no longer credited as full coverage). **Deployed.**
- `68303c8` — Stage 9 duty eligibility uses actual generated rest (`ActualRestHoursByEmployeeDay`), not the stale static `employee.rest_before_shift_hours` field. **Deployed.**
- `25c7fe0` — Priority 2: joint bucket-level set-cover solver replacing the fixed-role-order greedy heuristic for General T1. **Deployed.**
- `5a739aa` — docs only: recorded roster-planning vs. duty-allocation as an explicit known limitation (§12). **Deployed.**
- `ad45042` — multi-week Flight Program backend foundation: migration `0013`, `lib/flight-date.ts`, new `/api/flights*` routes, critical unscoped-query fix. **Deployed; migration run.**
- `45d7d6f` — multi-week Flight Program frontend: real week nav, Add/Edit/Remove/Import UI, staleness banner. **Deployed.**
- `1f8312b` — **root-cause fix: `CURRENT_WEEK_START` corrected + Import Flights week-scoping bug fixed. Committed locally, patch handed to user, NOT YET CONFIRMED DEPLOYED as of this handoff — see §19, this is the starting point for the next session.**

## 11. What has actually been deployed / migrated (as of this handoff)

- Deployed through `45d7d6f` for certain (user confirmed "pushed and deployed").
- Migration `0013` has been run against the live Supabase project (user confirmed).
- **`1f8312b` is the open question.** Last live check (via the deployed app) showed `GET /api/planning/weekly-view` still returning `weekStart: "2026-09-01"` and `weekLabel: "Week of Tue, Sep 1 2026"` — the OLD, uncorrected value — meaning `1f8312b` had NOT been deployed at the time of that check. **Verify this first, live, before doing anything else.**

## 12. Roster-planning vs. duty-allocation — why intentionally not implemented

Documented in full in `docs/known-limitations/roster-planning-vs-duty-allocation.md` (commit `5a739aa`). Summary: RAM Handling requires employees to fulfill a real working-hours/roster obligation — flight demand should determine WHAT duty they do, not WHETHER they work at all. Today's Stage 6 conflates the two (an employee with no demand-driven task is left fully OFF, not rostered-but-idle), producing real employees OFF all week even at 100% coverage. **Explicitly NOT to be fixed by inventing a target-hours algorithm** — the real RAM obligation is not yet confirmed, and `maximum_average_weekly_working_hours` (42h, an average ceiling) must never be repurposed as that floor. Sequencing: multi-week Flight Program first (in progress), then confirm the real obligation with the user, then redesign Stage 6 jointly against it plus 15h rest, OFF rules, qualifications, demand, shift compatibility, cross-week continuity, and fairness.

## 13. Known unresolved fairness issue

At the 257/257 baseline, one General T1 employee (`youssef-el-amrani`) was rostered **all 7 days, identical shift code, 63 hours total**, with rest exactly at the 15h floor every night — legal, zero hard-rule violations, but not fair. Root cause: the joint solver's greedy scoring compares coverage VALUE before fairness (hours-so-far is only a tie-break), so a consistently-best-fit candidate can win every day. **Not fixed** — flagged as a real, specific example for the eventual roster-planning/fairness redesign (§12). Do not attempt a quick fix (e.g. a rotation cap) without revisiting this as part of that larger redesign — a narrow patch here risks conflicting with the eventual real objective function.

## 14. T1 Check-in zone model — planned, not implemented

Full architecture approved in conversation but **zero code written**. Summary: RAM Check-in at Terminal 1 should be modeled as **shared zone/counter capacity** (Main, Business, Italy/Spain, Domestic, Staff, Oversized Baggage), not independent per-flight requirements like Gate/Boarding. Key decisions already made, to reuse when implementing:
- Counter boundary overlaps (76, 26) are configuration, explicitly left unconfirmed/flagged, never silently resolved.
- Italy/Spain vs. rest-of-Europe needs real route/country data — build a configurable mapping using actual destination/IATA data, not a full geography subsystem.
- Business/Staff/Oversized Baggage get NO automatic staffing formula yet — manually/config-driven only until the real rule is confirmed.
- Zone staffing formula itself: a clearly-marked SYNTHETIC/PROTOTYPE placeholder only (simultaneous open RAM flights + passenger load as inputs), replaceable later without changing the planner's shape.
- Employee eligibility: normal `Check-in` skill qualifies for ordinary RAM zones; no separate Business/Domestic/Italy-Spain qualification invented.
- Duties become zone/counter duties (`T1 Main Check-in · counters 30–76 · 05:45–08:30`), not fake flight-specific ones; `contributingFlightIds` for traceability, but must be architected as replaceable by a normalized relationship later, not permanently JSON.
- UI: progressive disclosure inside the existing Flight Schedule/Coverage/Agent Schedule tabs — no new top-level tab yet.
- Gate/Boarding/Profiling/Mesure/foreign-company models are explicitly UNCHANGED by this redesign.
- **Explicitly sequenced AFTER the current multi-week Flight Program task is fully closed out** — do not start this until §19 is resolved.

## 15. Foreign-company planning model

Untouched by all recent work. `lib/foreign-company-window.ts` (protected commitment windows), `lib/company-config.ts` (`CONFIGURED_COMPANIES`, per-company required agents), `lib/foreign-shift-planning.ts` (`selectCompatibleShiftCode(s)` — the foreign-company call path always uses strict full-containment window matching, deliberately different from the demand-cluster `allowLateStart` relaxation used by General T1/Profiling/Mesure — do not accidentally unify these, they represent genuinely different commitments).

## 16. Things that must NOT be changed or guessed

- Do not invent the real Check-in staffing formula, RAM T1 zone formula, or working-hours/roster obligation — all explicitly unconfirmed, all explicitly flagged as prototype/placeholder where they exist.
- Do not treat `maximum_average_weekly_working_hours` (42h) as a per-employee weekly target.
- Do not weaken the 15h rest rule, the `flights_date_matches_day_of_week` CHECK constraint, or any overlap/qualification/OFF-day hard invariant, ever, for any reason including "just to get coverage."
- Do not change role-processing order as a shortcut for a coverage gap — the scarcest-first principle (§8) is the correct, general mechanism; a hardcoded order will silently break again.
- Do not touch Profiling/Mesure/foreign-company/fixed-cycle logic while working on General T1 or the T1 Check-in redesign unless a real interface change is proven necessary.
- Do not push to GitHub or run SQL directly — hand the user a patch/SQL and wait for confirmation of what's actually live before assuming so.
- Do not produce a new standalone handoff/summary doc after ordinary work in future sessions (per the user's standing preference) — this document is an explicit, one-time exception because the user asked for it directly.

## 17. Current test/build baseline

As of commit `1f8312b` (local, not yet deployed): **38 test files, 305 tests, all passing.** `tsc --noEmit` clean. `next build` succeeds (all routes compile, including every `/api/flights*` route). Run `npx vitest run`, `npx tsc --noEmit -p tsconfig.json`, `npm run build` after any change, before considering it done.

## 18. CSV import note (not a bug)

The user's own test CSV used `booking_pressure = high`; the importer correctly accepts only `normal | elevated` (`lib/flight-import.ts`) and rejects `high` rows. **This is correct, confirmed behavior — do not loosen this validation.** It explains most of the "109 rejected" rows seen in the live test screenshot; it is unrelated to the real bugs below.

---

# CURRENT TASK — START HERE

**First, before anything else: verify live whether commit `1f8312b` has been deployed.** Fetch `GET https://atlas-demo-kappa.vercel.app/api/planning/weekly-view` and check `weekStart`/`weekLabel` in the response. If it still shows `"2026-09-01"` / `"Week of Tue, Sep 1 2026"`, the fix below is written and committed but not live — ask the user to `git am` the patch (already given to them, or regenerate from commit `1f8312b` in the local clone if it still exists) and push, and to confirm no new migration is needed (there isn't one for this commit). If it already shows `"2026-08-31"` / `"Week of Mon, Aug 31 2026"`, the fix is live — proceed straight to re-testing Reset Demo and Import Flights live and confirming the bugs below are actually resolved, then close this task out.

The bugs originally found (**already fixed in code, in commit `1f8312b`, pending deployment confirmation**):

1. **Reset Demo failed** with `new row for relation "flights" violates check constraint "flights_date_matches_day_of_week"`.
2. **Import preview worked, but after Confirm Import the accepted flights did not appear in Flight Schedule.**
3. Traced the full path (selected week → preview → commit payload → inserted `flight_date`/derived `week_start` → DB rows → `GET /api/flights?week_start=...` → UI refetch) and found the write and refetch were BOTH working correctly — the row was just being written under a different `week_start` than the one being viewed.
4. **Root cause of both 1 and 2, and of the UI showing "Week of Tue, Sep 1 2026":** `CURRENT_WEEK_START` (`lib/seed-data.ts`) was `"2026-09-01"`, which is calendrically a **Tuesday**, not a Monday — a mislabeling that predates this entire project and was only ever caught because this milestone introduced real calendar validation. Fixed: `CURRENT_WEEK_START` corrected to `"2026-08-31"` (a real Monday); `CURRENT_WEEK_LABEL` is now derived via `weekLabelFor()` instead of an independent hardcoded string, establishing the one canonical week-boundary definition used everywhere (navigation, `flight_date → week_start`, importer, Add/Edit Flight, Reset Demo, `GET /api/flights`, Make Planning, `WeeklyPlan` identity/hash).
5. **The DB constraint (`flights_date_matches_day_of_week`) was NOT weakened** — the fix corrected the data assumption that was violating it, per instruction.
6. **Import Flights week-scoping bug, separately fixed:** `lib/flight-import.ts`'s `validateRow`/`validateImportFile` used to derive each row's `week_start` independently from its own `flight_date`, ignoring which week was actually selected — a row for a different real week would silently commit into that other week's bucket. Fixed: both functions now take the selected `weekStart` and **reject** (never silently relocate) a row whose real week doesn't match, naming the exact mismatch in the rejection reason. Threaded through `app/api/flights/import/route.ts` and `app/api/flights/import/commit/route.ts`.
7. **Regression/integration tests added:** `tests/flight-date.test.ts` (guards `CURRENT_WEEK_START` is always a real Monday, `flightDateFor` round-trips correctly for all 7 weekdays, `CURRENT_WEEK_LABEL` stays derived) and `tests/flight-import.test.ts` (same-week row accepted; cross-week row rejected with exact message; mixed file only accepts matching rows; full preview→commit→scoped-read simulation proves the imported flight is returned for the selected week and absent from a different one).
8. **Planner allocation, fairness, working-hours behavior, staffing rules, and the T1 Check-in model were NOT touched** while making this fix — confirmed via the unchanged 305-test baseline (only new/updated date-and-import-specific tests were added).

**Also fixed proactively, same bug class:** Add Flight and Edit Flight could previously insert/move a flight to a date outside the currently-viewed week with the same "silently invisible" result. Rather than reject (single deliberate actions, unlike bulk import), the app now automatically switches to whichever week the added/edited flight's date actually belongs to (`components/add-flight-form.tsx`, `components/flight-schedule-view.tsx`, `app/planning/page.tsx`).

**Once deployment is confirmed and live-verified:** re-run Make Planning on the (now correctly-dated) demo week, re-confirm the 257/257 baseline still holds (it should — no planner logic changed), then this multi-week Flight Program milestone is fully closed. Only after that should the T1 Check-in zone redesign (§14) begin, per the user's own explicit sequencing.
