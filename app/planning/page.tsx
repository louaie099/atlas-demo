"use client";

import { useEffect, useMemo, useState } from "react";
import { Flight, RosterRequirementView, AgentScheduleEntry, WeeklyPlan } from "@/lib/types";
import { ZoneCoverageView } from "@/lib/planning/persisted-plan-view";
import { PlanIssue } from "@/lib/planning/validation";
import { FlightCoverageRow } from "@/components/flight-coverage-card";
import { ZoneCoverageSection } from "@/components/zone-coverage-card";
import { FindAgentSheet } from "@/components/find-agent-sheet";
import { ZoneFindAgentSheet } from "@/components/zone-find-agent-sheet";
import { SummaryDrilldownSheet, SummaryMetric } from "@/components/summary-drilldown-sheet";
import { AddFlightForm } from "@/components/add-flight-form";
import { ImportFlightsDialog } from "@/components/import-flights-dialog";
import { MonthNav } from "@/components/month-nav";
import { PlanningSummaryBar } from "@/components/planning-summary-bar";
import { AgentScheduleTable } from "@/components/agent-schedule-table";
import { FlightScheduleView } from "@/components/flight-schedule-view";
import { MakePlanningButton } from "@/components/make-planning-button";
import { PlanningRulesBar } from "@/components/planning-rules-bar";
import { Button } from "@/components/ui";
import { monthStartFor, shiftMonth, weeksOverlappingMonth, weekDates } from "@/lib/flight-date";

// Workflow order: see the imported schedule (Flight Schedule) -> see what
// ATLAS generated for it (Flight Coverage) -> see the resulting employee
// roster (Agent Schedule). All three read the SAME weekly-view response —
// see loadWeeklyPlan below — never three independent datasets.
type Tab = "flights" | "coverage" | "schedule";

// MONTHLY PLANNING (2026-10-03 product correction): ATLAS is a monthly
// workforce planning system, not fundamentally a weekly one -- the MONTH
// is the planning horizon management prepares from the flight program; a
// WEEK is an inspection/working view inside that horizon, kept for
// readability (Flight Schedule/Coverage/Agent Schedule all stay
// week-sized views -- a 31-column table would be unreadable, not more
// "monthly").
//
// This is deliberately a thin UI-layer correction, not a backend rewrite
// (2-day demo constraint): `weekStart` remains the single real unit of
// work for every fetch/mutation below (loadWeeklyPlan, Make Planning,
// Import/Add Flight, Find Agent) exactly as before -- nothing about the
// persisted WeeklyPlan/weekly_plans model changed. `monthStart` is new,
// derived state that exists ONLY to decide which weeks to show
// (lib/flight-date.ts's weeksOverlappingMonth) and which month label to
// render; it never drives a fetch directly. Planning Rules already
// resolve the same way regardless of which week is selected (effective-
// dated, not week-scoped caching -- see rules-service.ts), so navigating
// weeks inside a month, or across a month boundary, never resets them;
// the cross-week roster continuity work (lib/planning/off-block-
// continuity.ts and friends) is itself entirely calendar-date-based, so
// it already carries through a month boundary with no special-casing
// here either.

/**
 * Non-interactive placeholder for the future Generate -> Review -> Adjust ->
 * Publish lifecycle. Only "Generate" is real today (this page IS that
 * step -- ATLAS already generated the draft on load). The rest are shown
 * muted and are deliberately not buttons: there is no Review/Adjust/
 * Publish workflow implemented yet, and this must not pretend there is.
 */
function DraftLifecycle() {
  const steps = ["Generate", "Review", "Adjust", "Publish"];
  return (
    <div className="flex items-center gap-1.5 text-xs">
      {steps.map((step, i) => (
        <div key={step} className="flex items-center gap-1.5">
          <span
            className={
              i === 0
                ? "px-2 py-0.5 rounded-full bg-brand-50 text-brand-700 font-medium"
                : "px-2 py-0.5 rounded-full text-muted"
            }
          >
            {step}
          </span>
          {i < steps.length - 1 && <span className="text-border">{"->"}</span>}
        </div>
      ))}
    </div>
  );
}

/** Pure view transformation of `roster` -- one group per flight, in the
 * order flights already arrive (buildRosterViews sorts by day then
 * departure time), each carrying every requirement view for that flight.
 * No independent Flight Coverage dataset -- same requirements, regrouped. */
function groupByFlight(roster: RosterRequirementView[]): { flight: Flight; views: RosterRequirementView[] }[] {
  const groups: { flight: Flight; views: RosterRequirementView[] }[] = [];
  const indexByFlightId = new Map<string, number>();

  for (const view of roster) {
    const existingIndex = indexByFlightId.get(view.flight.id);
    if (existingIndex === undefined) {
      indexByFlightId.set(view.flight.id, groups.length);
      groups.push({ flight: view.flight, views: [view] });
    } else {
      groups[existingIndex].views.push(view);
    }
  }

  return groups;
}

export default function PlanningPage() {
  const [tab, setTab] = useState<Tab>("flights");
  const [flights, setFlights] = useState<Flight[] | null>(null);
  const [roster, setRoster] = useState<RosterRequirementView[] | null>(null);
  const [schedule, setSchedule] = useState<AgentScheduleEntry[] | null>(null);
  const [zoneCoverage, setZoneCoverage] = useState<ZoneCoverageView[] | null>(null);
  const [issues, setIssues] = useState<PlanIssue[]>([]);
  const [plan, setPlan] = useState<WeeklyPlan | null | undefined>(undefined); // undefined = not loaded yet
  const [isStale, setIsStale] = useState(false);
  const [openRequirementId, setOpenRequirementId] = useState<string | null>(null);
  const [openZoneRequirementId, setOpenZoneRequirementId] = useState<string | null>(null);
  // Part 3: which PlanningSummaryBar drill-down (if any) is open, and the
  // real navigation targets it can hand off to -- same useState-driven
  // slide-over pattern as openRequirementId/FindAgentSheet above, never a
  // new top-level page.
  const [openMetric, setOpenMetric] = useState<SummaryMetric | null>(null);
  const [coverageFocus, setCoverageFocus] = useState<{ flightId: string; token: number } | null>(null);
  const [zoneCoverageFocus, setZoneCoverageFocus] = useState<{ zoneRequirementId: string; token: number } | null>(null);
  const [scheduleFocus, setScheduleFocus] = useState<{ employeeId: string; dayOfWeek?: string; token: number } | null>(null);

  // weekStart is the REAL, authoritative selected week -- null only until
  // the first response tells us which week the server resolved (see
  // loadWeeklyPlan below). Every fetch/action below (Flight Schedule,
  // Make Planning, Add/Edit/Remove/Import Flights) is scoped by this one
  // value -- there is no longer an implicit "current week" anywhere on
  // this page.
  const [weekStart, setWeekStart] = useState<string | null>(null);

  // monthStart is new (2026-10-03, Monthly Planning): purely derived
  // display/navigation state, never a unit of work on its own (see the
  // module doc comment above). It is "sticky" -- it only snaps to a new
  // month when the resolved weekStart actually falls outside the
  // currently-displayed month's week list (see loadWeeklyPlan below) --
  // so clicking between weeks already shown under the selected month, or
  // using Prev/Next week, never fights the user's own month selection.
  // When it does need to snap (e.g. Prev/Next week crossed out of the
  // shown range), it uses the month containing that week's THURSDAY, the
  // same "a week belongs to the month most of it falls in" convention ISO
  // week-numbering uses -- not the week's Monday, which can land in the
  // PRIOR month (e.g. the week of Mon Sep 28 is the first week shown for
  // October, since Oct 1 2026 is a Thursday) and would otherwise make
  // selecting October immediately snap back to September.
  const [monthStart, setMonthStart] = useState<string | null>(null);

  // Failure-safe loading (2026-09-29 fix): loadWeeklyPlan's fetch chain
  // previously had NO .catch() anywhere, so a rejected fetch, a non-2xx
  // response, or a response body that failed to parse as JSON left every
  // state above (plan/flights/weekStart/...) stuck at its initial
  // "loading" sentinel forever -- the page showed LOADING.../"Loading
  // flight schedule..."/"Select week" permanently, with no error and no
  // way to retry. loadError is set on any such failure and read below to
  // render an explicit error/retry state instead. It is deliberately NOT
  // conflated with `plan === null` ("no plan generated yet for this
  // week") -- that is a normal, successful response, not a failure.
  const [loadError, setLoadError] = useState<string | null>(null);

  // Single fetch, single computed plan: Flight Coverage, the summary bar,
  // and Agent Schedule all come from the same /api/planning/weekly-view
  // response -- one generateDraftWeeklyPlan() run per load, not two
  // independent ones that could read the database at slightly different
  // moments and silently disagree.
  //
  // Returns the fetch's own promise (never fire-and-forget) so a caller
  // that needs to know the new data has actually landed -- specifically
  // MakePlanningButton, which must not announce success until this
  // refetch has resolved and every dependent view has re-rendered with
  // it -- can await it. `cache: "no-store"` is explicit, not just relying
  // on the route's own `force-dynamic`: this is a normal browser fetch
  // from client code, not a Next.js server fetch, so nothing else stops
  // an intermediate HTTP cache from serving a stale response to THIS
  // specific call the moment it matters most (immediately after Make
  // Planning just changed what this same URL returns).
  //
  // Resolves with the freshly-fetched plan (not just void) so a caller
  // can verify WHICH revision actually landed in state, not merely that
  // *a* response came back -- see MakePlanningButton's read-after-write
  // consistency check, which compares this against the revision Make
  // Planning itself just persisted before it will show success.
  function loadWeeklyPlan(targetWeekStart?: string): Promise<WeeklyPlan | null> {
    const url = targetWeekStart ? `/api/planning/weekly-view?week_start=${targetWeekStart}` : "/api/planning/weekly-view";
    setLoadError(null);
    return fetch(url, { cache: "no-store" })
      .then(async (r) => {
        // A non-2xx response (eg. the 500 this route returns when a
        // dependent query -- including resolveEffectiveConfig's
        // planning_labor_rules/planning_fatigue_config lookups -- throws,
        // such as a missing table from an unapplied migration) must not be
        // parsed as if it were the normal payload: surface its message and
        // stop, rather than setting state from whatever shape the error
        // body happens to have.
        let body: { error?: string; [key: string]: unknown };
        try {
          body = await r.json();
        } catch {
          throw new Error(`Server returned ${r.status} ${r.statusText || ""}.`.trim());
        }
        if (!r.ok) throw new Error(body.error ?? `Server returned ${r.status}.`);
        return body;
      })
      .then((data) => {
        const resolvedWeekStart = (data.weekStart as string | undefined) ?? targetWeekStart ?? null;
        setWeekStart(resolvedWeekStart);
        if (resolvedWeekStart) {
          const owningMonth = monthStartFor(weekDates(resolvedWeekStart)[3]); // Thursday-of-week owns the month
          setMonthStart((prev) => (prev === null || !weeksOverlappingMonth(prev).includes(resolvedWeekStart) ? owningMonth : prev));
        }
        setFlights((data.flights as Flight[]) ?? []);
        setRoster((data.roster as RosterRequirementView[]) ?? []);
        setSchedule((data.schedule as AgentScheduleEntry[]) ?? []);
        setZoneCoverage((data.zoneCoverage as ZoneCoverageView[]) ?? []);
        setIssues((data.issues as PlanIssue[]) ?? []);
        setPlan((data.plan as WeeklyPlan | null) ?? null);
        setIsStale(Boolean(data.isStale));
        return (data.plan as WeeklyPlan | null) ?? null;
      })
      .catch((err) => {
        setLoadError(err instanceof Error ? err.message : "Unable to load the weekly plan.");
        // Re-thrown so a caller that specifically needs to know this
        // refetch failed (MakePlanningButton's read-after-write check)
        // still sees a rejection -- loadError above is what drives this
        // page's own UI, independent of whether a given caller awaits it.
        throw err;
      });
  }

  useEffect(() => {
    // Fire-and-forget from the page's own perspective -- the failure is
    // already reflected in loadError/the UI below; this .catch just stops
    // an unhandled-rejection warning for the one caller (this effect) that
    // never awaits the promise.
    loadWeeklyPlan().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flightGroups = useMemo(() => groupByFlight(roster ?? []), [roster]);
  const daysWithData = Array.from(new Set(flightGroups.map((g) => g.flight.day_of_week)));
  const weeksInMonth = useMemo(() => (monthStart ? weeksOverlappingMonth(monthStart) : []), [monthStart]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-2xl font-semibold text-ink">Monthly Planning</h1>
            <span
              className={`px-2.5 py-1 rounded-full text-xs font-medium uppercase tracking-wide ${
                plan === undefined && loadError ? "bg-bad-50 text-bad-700" : "bg-gray-100 text-gray-600"
              }`}
            >
              {plan === undefined
                ? loadError
                  ? "Unable To Load"
                  : "Loading…"
                : plan === null
                  ? "No Plan Yet"
                  : plan.status === "published"
                    ? "Published Plan"
                    : "Draft Weekly Plan"}
            </span>
          </div>
          <p className="text-muted mt-1 max-w-2xl">
            {plan === null
              ? "No plan has been generated for this week yet. Click Make Planning to generate one from the current flight schedule."
              : "ATLAS generated this plan from the weekly flight program -- every requirement traces back to a flight and a rule. Normal staffing below is assigned directly as part of the draft plan; management can still review and edit the whole draft before publishing. Only exceptional situations -- a renfort decision, a live-operational reassignment -- are surfaced as recommendations awaiting a human decision. After changing the flight schedule or the planning rules above, click Make Planning to regenerate this plan from the updated program -- a page refresh alone never does this."}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <DraftLifecycle />
          <PlanningRulesBar />
          {weekStart && <MakePlanningButton weekStart={weekStart} onDone={() => loadWeeklyPlan(weekStart ?? undefined)} />}
        </div>
      </div>

      <MonthNav
        monthStart={monthStart}
        weekStart={weekStart}
        weeksInMonth={weeksInMonth}
        hasData={(flights?.length ?? 0) > 0}
        onSelectMonth={(target) => {
          setMonthStart(target);
          const firstWeek = weeksOverlappingMonth(target)[0];
          if (firstWeek) loadWeeklyPlan(firstWeek).catch(() => {});
        }}
        onPrevMonth={() => {
          const target = shiftMonth(monthStart ?? monthStartFor(weekStart ?? new Date().toISOString().slice(0, 10)), -1);
          setMonthStart(target);
          const firstWeek = weeksOverlappingMonth(target)[0];
          if (firstWeek) loadWeeklyPlan(firstWeek).catch(() => {});
        }}
        onNextMonth={() => {
          const target = shiftMonth(monthStart ?? monthStartFor(weekStart ?? new Date().toISOString().slice(0, 10)), 1);
          setMonthStart(target);
          const firstWeek = weeksOverlappingMonth(target)[0];
          if (firstWeek) loadWeeklyPlan(firstWeek).catch(() => {});
        }}
        onSelectWeek={(target) => loadWeeklyPlan(target).catch(() => {})}
      />

      {plan && plan.status === "draft" && isStale && (
        <div className="bg-warn-50 border border-warn-200 text-warn-700 rounded-xl2 px-4 py-3 text-sm flex items-center justify-between gap-3">
          <span>The flight schedule or planning rules have changed since this draft was generated. Click Make Planning to update it.</span>
        </div>
      )}

      {loadError && (
        <div className="bg-bad-50 border border-bad-500/30 text-bad-700 rounded-xl2 px-4 py-3 text-sm flex items-center justify-between gap-3">
          <span>Unable to load the weekly plan -- {loadError}</span>
          <Button variant="secondary" className="!py-1.5 text-xs shrink-0" onClick={() => loadWeeklyPlan(weekStart ?? undefined).catch(() => {})}>
            Retry
          </Button>
        </div>
      )}

      {/* Once a load has failed and NOTHING has ever loaded successfully
          (weekStart is still null), none of the tables below have any data
          to show anyway -- render the retry banner above in place of the
          whole workspace rather than a page full of permanent "Loading..."
          placeholders underneath it. A failure on a LATER refetch (weekStart
          already set from an earlier success) instead keeps showing the
          last-known-good data beneath the banner. */}
      {!(loadError && weekStart === null) && <>
          {flights && roster && (
            <PlanningSummaryBar flights={flights} roster={roster} issues={issues} zoneCoverage={zoneCoverage ?? []} onSelectMetric={setOpenMetric} />
          )}

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex gap-1 bg-white border border-border rounded-xl2 p-1 self-start">
              <button
                onClick={() => setTab("flights")}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium ${
                  tab === "flights" ? "bg-brand-50 text-brand-700" : "text-muted hover:text-ink"
                }`}
              >
                Flight Schedule
              </button>
              <button
                onClick={() => setTab("coverage")}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium ${
                  tab === "coverage" ? "bg-brand-50 text-brand-700" : "text-muted hover:text-ink"
                }`}
              >
                Flight Coverage
              </button>
              <button
                onClick={() => setTab("schedule")}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium ${
                  tab === "schedule" ? "bg-brand-50 text-brand-700" : "text-muted hover:text-ink"
                }`}
              >
                Agent Schedule
              </button>
            </div>

            {/* Import Flights / Add Flight live next to the page/week controls,
                only on the Flight Schedule tab -- this is flight-program
                input, not workforce planning, so it never appears alongside
                Flight Coverage or Agent Schedule. */}
            {tab === "flights" && weekStart && (
              <div className="flex gap-2">
                <ImportFlightsDialog weekStart={weekStart} onImported={() => loadWeeklyPlan(weekStart).catch(() => {})} />
                <AddFlightForm weekStart={weekStart} onAdded={(newFlightWeekStart) => loadWeeklyPlan(newFlightWeekStart).catch(() => {})} />
              </div>
            )}
          </div>

          {tab === "flights" && (
            <>
              {flights === null && <p className="text-sm text-muted">Loading flight schedule...</p>}
              {flights && weekStart && (
                <FlightScheduleView flights={flights} onChanged={(newWeekStart) => loadWeeklyPlan(newWeekStart ?? weekStart).catch(() => {})} />
              )}
              {flights && flights.length === 0 && (
                <div className="bg-white border border-border rounded-xl2 px-4 py-6 text-center text-sm text-muted">
                  No scheduled flights for this week yet. Use Import Flights or Add Flight above.
                </div>
              )}
            </>
          )}

          {tab === "coverage" && (
            <div className="flex flex-col gap-6">
              {roster === null && <p className="text-sm text-muted">Loading flights...</p>}

              {daysWithData.map((day) => (
                <div key={day} className="flex flex-col gap-2">
                  <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">{day}</h2>
                  <div className="flex flex-col gap-2">
                    {flightGroups
                      .filter((g) => g.flight.day_of_week === day)
                      .map((g) => (
                        <FlightCoverageRow
                          key={g.flight.id}
                          flight={g.flight}
                          views={g.views}
                          onFindAgent={setOpenRequirementId}
                          focus={coverageFocus}
                        />
                      ))}
                  </div>
                </div>
              ))}

              {/* T1 Check-in ZONE coverage -- a genuinely separate section
                  from the per-flight rows above (Check-in is no longer a
                  per-flight requirement; see lib/checkin-zones.ts). Shown
                  after every day's flight rows so Flight Coverage still
                  reads day-by-day, flight-specific coverage first. */}
              {daysWithData.map((day) => (
                <ZoneCoverageSection
                  key={`zone-${day}`}
                  day={day}
                  views={(zoneCoverage ?? []).filter((v) => v.dayOfWeek === day)}
                  onFindAgent={setOpenZoneRequirementId}
                  focus={zoneCoverageFocus}
                />
              ))}
            </div>
          )}

          {tab === "schedule" && (
            <>
              {schedule === null && <p className="text-sm text-muted">Loading schedule...</p>}
              {schedule && <AgentScheduleTable schedule={schedule} focus={scheduleFocus} />}
            </>
          )}
      </>}

      {openMetric && flights && roster && (
        <SummaryDrilldownSheet
          metric={openMetric}
          flights={flights}
          roster={roster}
          issues={issues}
          zoneCoverage={zoneCoverage ?? []}
          onClose={() => setOpenMetric(null)}
          onFindAgent={setOpenRequirementId}
          onFindZoneAgent={(zoneRequirementId) => {
            setTab("coverage");
            setZoneCoverageFocus({ zoneRequirementId, token: Date.now() });
            setOpenZoneRequirementId(zoneRequirementId);
          }}
          onNavigateToFlight={(flightId) => {
            setTab("coverage");
            setCoverageFocus({ flightId, token: Date.now() });
          }}
          onNavigateToWarning={(issue) => {
            if (issue.employeeId) {
              setTab("schedule");
              setScheduleFocus({ employeeId: issue.employeeId, dayOfWeek: issue.dayOfWeek, token: Date.now() });
            } else if (issue.requirementId) {
              const view = (roster ?? []).find((v) => v.requirement.id === issue.requirementId);
              setTab("coverage");
              if (view) setCoverageFocus({ flightId: view.flight.id, token: Date.now() });
            }
          }}
        />
      )}

      {openRequirementId && (
        <FindAgentSheet
          requirementId={openRequirementId}
          onClose={() => setOpenRequirementId(null)}
          // Real bug fix: passing `loadWeeklyPlan` directly here means
          // FindAgentSheet's own `onAssigned()` call (no arguments) was
          // silently refetching loadWeeklyPlan(undefined) -- which
          // resolves to the DEFAULT demo week (CURRENT_WEEK_START, see
          // /api/planning/weekly-view's own default), not whatever week
          // the planner is actually looking at. A Find Agent assignment
          // made while viewing a future/past week (via Prev/Next) would
          // silently reset Flight Coverage/Agent Schedule back to the
          // default week's data right after a successful assign -- the
          // gap/coverage counts appeared to update, but for the WRONG
          // week, while the currently-viewed week's own view went stale.
          // Explicitly re-passing the real `weekStart` keeps the refetch
          // scoped to whatever week is actually open.
          onAssigned={() => loadWeeklyPlan(weekStart ?? undefined).catch(() => {})}
        />
      )}

      {openZoneRequirementId && (
        <ZoneFindAgentSheet
          zoneRequirementId={openZoneRequirementId}
          onClose={() => setOpenZoneRequirementId(null)}
          onAssigned={() => loadWeeklyPlan(weekStart ?? undefined).catch(() => {})}
        />
      )}
    </div>
  );
}
