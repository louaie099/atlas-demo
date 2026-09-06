"use client";

import { useEffect, useMemo, useState } from "react";
import { Flight, RosterRequirementView, AgentScheduleEntry } from "@/lib/types";
import { PlanIssue } from "@/lib/planning/validation";
import { FlightCoverageRow } from "@/components/flight-coverage-card";
import { FindAgentSheet } from "@/components/find-agent-sheet";
import { AddFlightForm } from "@/components/add-flight-form";
import { WeekNav } from "@/components/week-nav";
import { PlanningSummaryBar } from "@/components/planning-summary-bar";
import { AgentScheduleTable } from "@/components/agent-schedule-table";
import { FlightScheduleView } from "@/components/flight-schedule-view";

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
  const [issues, setIssues] = useState<PlanIssue[]>([]);
  const [openRequirementId, setOpenRequirementId] = useState<string | null>(null);

  // Week navigation is real infrastructure, but only one week currently has
  // data -- this is intentional: no fabricated flights for other weeks.
  const [weekOffset, setWeekOffset] = useState(0);
  const weekLabel =
    weekOffset === 0
      ? "Week of Mon, Sep 1 2026"
      : `Week of Mon, Sep ${1 + weekOffset * 7} 2026`;

  // Single fetch, single computed plan: Flight Coverage, the summary bar,
  // and Agent Schedule all come from the same /api/planning/weekly-view
  // response -- one generateDraftWeeklyPlan() run per load, not two
  // independent ones that could read the database at slightly different
  // moments and silently disagree.
  function loadWeeklyPlan() {
    fetch("/api/planning/weekly-view")
      .then((r) => r.json())
      .then((data) => {
        setFlights(data.flights ?? []);
        setRoster(data.roster ?? []);
        setSchedule(data.schedule ?? []);
        setIssues(data.issues ?? []);
      });
  }

  useEffect(() => {
    loadWeeklyPlan();
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
              Draft Weekly Plan
            </span>
          </div>
          <p className="text-muted mt-1 max-w-2xl">
            ATLAS generated this plan from the weekly flight program -- every requirement traces back
            to a flight and a rule. Normal staffing below is assigned directly as part of the draft
            plan; management can still review and edit the whole draft before publishing. Only
            exceptional situations -- a renfort decision, a live-operational reassignment -- are
            surfaced as recommendations awaiting a human decision.
          </p>
        </div>
        <DraftLifecycle />
      </div>

      <WeekNav
        weekLabel={weekLabel}
        hasData={weekOffset === 0}
        onPrev={() => setWeekOffset((w) => w - 1)}
        onNext={() => setWeekOffset((w) => w + 1)}
      />

      {weekOffset !== 0 && (
        <div className="bg-white border border-border rounded-xl2 px-4 py-6 text-center text-sm text-muted">
          No scheduled flights for this week yet. Only the current week has demo data.
        </div>
      )}

      {weekOffset === 0 && (
        <>
          {flights && roster && <PlanningSummaryBar flights={flights} roster={roster} issues={issues} />}

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

            {/* Secondary action -- manual Add Flight lives next to the page/week
                controls, not inside the flight list itself, so it never competes
                with the operational program for visual weight (still just the
                collapsed "+ Add Flight" button unless clicked open). */}
            {tab === "coverage" && <AddFlightForm onAdded={loadWeeklyPlan} />}
          </div>

          {tab === "flights" && (
            <>
              {flights === null && <p className="text-sm text-muted">Loading flight schedule...</p>}
              {flights && <FlightScheduleView flights={flights} />}
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
                        />
                      ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === "schedule" && (
            <>
              {schedule === null && <p className="text-sm text-muted">Loading schedule...</p>}
              {schedule && <AgentScheduleTable schedule={schedule} />}
            </>
          )}
        </>
      )}

      {openRequirementId && (
        <FindAgentSheet
          requirementId={openRequirementId}
          onClose={() => setOpenRequirementId(null)}
          onAssigned={loadWeeklyPlan}
        />
      )}
    </div>
  );
}
