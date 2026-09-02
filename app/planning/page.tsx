"use client";

import { useEffect, useState } from "react";
import { RosterRequirementView, AgentScheduleEntry } from "@/lib/types";
import { FlightCoverageCard } from "@/components/flight-coverage-card";
import { FindAgentSheet } from "@/components/find-agent-sheet";
import { AddFlightForm } from "@/components/add-flight-form";
import { WeekNav } from "@/components/week-nav";
import { PlanningSummaryBar } from "@/components/planning-summary-bar";
import { AgentScheduleTable } from "@/components/agent-schedule-table";

type Tab = "coverage" | "schedule";

export default function PlanningPage() {
  const [tab, setTab] = useState<Tab>("coverage");
  const [roster, setRoster] = useState<RosterRequirementView[] | null>(null);
  const [schedule, setSchedule] = useState<AgentScheduleEntry[] | null>(null);
  const [openRequirementId, setOpenRequirementId] = useState<string | null>(null);

  // Week navigation is real infrastructure, but only one week currently has
  // data — this is intentional: no fabricated flights for other weeks.
  const [weekOffset, setWeekOffset] = useState(0);
  const weekLabel =
    weekOffset === 0
      ? "Week of Mon, Sep 1 2026"
      : `Week of Mon, Sep ${1 + weekOffset * 7} 2026`;

  function loadRoster() {
    fetch("/api/roster")
      .then((r) => r.json())
      .then((data) => setRoster(data.roster ?? []));
  }

  function loadSchedule() {
    fetch("/api/agent-schedule")
      .then((r) => r.json())
      .then((data) => setSchedule(data.schedule ?? []));
  }

  useEffect(() => {
    loadRoster();
    loadSchedule();
  }, []);

  const daysWithData = Array.from(new Set((roster ?? []).map((v) => v.flight.day_of_week)));

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Weekly Planning</h1>
        <p className="text-muted mt-1">
          Scheduled flights → operation classification → staffing requirements → coverage. Every
          number below traces back to a flight and a rule — nothing is assumed.
        </p>
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
          {roster && <PlanningSummaryBar roster={roster} />}

          <div className="flex gap-1 bg-white border border-border rounded-xl2 p-1 self-start">
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

          {tab === "coverage" && (
            <div className="flex flex-col gap-6">
              <AddFlightForm onAdded={loadRoster} />

              {roster === null && <p className="text-sm text-muted">Loading flights…</p>}

              {daysWithData.map((day) => (
                <div key={day} className="flex flex-col gap-3">
                  <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">{day}</h2>
                  <div className="grid sm:grid-cols-2 gap-4">
                    {roster
                      ?.filter((v) => v.flight.day_of_week === day)
                      .map((view) => (
                        <FlightCoverageCard
                          key={view.requirement.id}
                          view={view}
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
              {schedule === null && <p className="text-sm text-muted">Loading schedule…</p>}
              {schedule && <AgentScheduleTable schedule={schedule} />}
            </>
          )}
        </>
      )}

      {openRequirementId && (
        <FindAgentSheet
          requirementId={openRequirementId}
          onClose={() => setOpenRequirementId(null)}
          onAssigned={() => {
            loadRoster();
            loadSchedule();
          }}
        />
      )}
    </div>
  );
}
