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
import { WeekNav } from "@/components/week-nav";
import { PlanningSummaryBar } from "@/components/planning-summary-bar";
import { AgentScheduleTable } from "@/components/agent-schedule-table";
import { FlightScheduleView } from "@/components/flight-schedule-view";
import { MakePlanningButton } from "@/components/make-planning-button";
import { shiftWeek } from "@/lib/flight-date";

// Workflow order: see the imported schedule (Flight Schedule) -> see what
// ATLAS generated for it (Flight Coverage) -> see the resulting employee
// roster (Agent Schedule). All three read the SAME weekly-view response —
// see loadWeeklyPlan below — never three independent datasets.
type Tab = "flights" | "coverage" | "schedule";

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
  const [weekLabel, setWeekLabel] = useState<string>("");

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
    return fetch(url, { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        setWeekStart(data.weekStart ?? targetWeekStart ?? null);
        setWeekLabel(data.weekLabel ?? "");
        setFlights(data.flights ?? []);
        setRoster(data.roster ?? []);
        setSchedule(data.schedule ?? []);
        setZoneCoverage(data.zoneCoverage ?? []);
        setIssues(data.issues ?? []);
        setPlan(data.plan ?? null);
        setIsStale(Boolean(data.isStale));
        return (data.plan ?? null) as WeeklyPlan | null;
      });
  }

  useEffect(() => {
    loadWeeklyPlan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flightGroups = useMemo(() => groupByFlight(roster ?? []), [roster]);
  const daysWithData = Array.from(new Set(flightGroups.map((g) => g.flight.day_of_week)));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-2xl font-semibold text-ink">Weekly Planning</h1>
            <span className="px-2.5 py-1 rounded-full bg-gray-100 text-gray-600 text-xs font-medium uppercase tracking-wide">
              {plan === undefined ? "Loading…" : plan === null ? "No Plan Yet" : plan.status === "published" ? "Published Plan" : "Draft Weekly Plan"}
            </span>
          </div>
          <p className="text-muted mt-1 max-w-2xl">
            {plan === null
              ? "No plan has been generated for this week yet. Click Make Planning to generate one from the current flight schedule."
              : "ATLAS generated this plan from the weekly flight program -- every requirement traces back to a flight and a rule. Normal staffing below is assigned directly as part of the draft plan; management can still review and edit the whole draft before publishing. Only exceptional situations -- a renfort decision, a live-operational reassignment -- are surfaced as recommendations awaiting a human decision. After changing the flight schedule, click Make Planning to regenerate this plan from the updated program -- a page refresh alone never does this."}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <DraftLifecycle />
          {weekStart && <MakePlanningButton weekStart={weekStart} onDone={() => loadWeeklyPlan(weekStart ?? undefined)} />}
        </div>
      </div>

      <WeekNav
        weekLabel={weekLabel}
        hasData={(flights?.length ?? 0) > 0}
        onPrev={() => weekStart && loadWeeklyPlan(shiftWeek(weekStart, -1))}
        onNext={() => weekStart && loadWeeklyPlan(shiftWeek(weekStart, 1))}
      />

      {plan && plan.status === "draft" && isStale && (
        <div className="bg-warn-50 border border-warn-200 text-warn-700 rounded-xl2 px-4 py-3 text-sm flex items-center justify-between gap-3">
          <span>The flight schedule has changed since this draft was generated. Click Make Planning to update it.</span>
        </div>
      )}

      <>
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
                <ImportFlightsDialog weekStart={weekStart} onImported={() => loadWeeklyPlan(weekStart)} />
                <AddFlightForm weekStart={weekStart} onAdded={(newFlightWeekStart) => loadWeeklyPlan(newFlightWeekStart)} />
              </div>
            )}
          </div>

          {tab === "flights" && (
            <>
              {flights === null && <p className="text-sm text-muted">Loading flight schedule...</p>}
              {flights && weekStart && (
                <FlightScheduleView flights={flights} onChanged={(newWeekStart) => loadWeeklyPlan(newWeekStart ?? weekStart)} />
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
                  views={(zoneCoverage ?? []).filter((v) => v.requirement.day_of_week === day)}
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
      </>

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
          onAssigned={() => loadWeeklyPlan(weekStart ?? undefined)}
        />
      )}

      {openZoneRequirementId && (
        <ZoneFindAgentSheet
          zoneRequirementId={openZoneRequirementId}
          onClose={() => setOpenZoneRequirementId(null)}
          onAssigned={() => loadWeeklyPlan(weekStart ?? undefined)}
        />
      )}
    </div>
  );
}
