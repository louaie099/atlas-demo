"use client";

import { useEffect, useState } from "react";
import { todayISO } from "@/lib/flight-date";
import { LiveOpsFlightView, LiveOpsView } from "@/lib/live-ops-service";
import { deriveFlightState } from "@/lib/live-ops-flight-state";
import { FlightOpsRow, DayRelation, LiveOpsAssignRequest } from "@/components/flight-ops-row";
import { EditFlightDrawer } from "@/components/edit-flight-drawer";
import { FindAgentSheet } from "@/components/find-agent-sheet";
import { Card } from "@/components/ui";

export default function OperationsPage() {
  const [date, setDate] = useState(todayISO());
  const [view, setView] = useState<LiveOpsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeConflictFlightIds, setActiveConflictFlightIds] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<LiveOpsFlightView | null>(null);
  // Every staffing requirement row must be actionable (2026-10-04): a
  // single shared sheet instance, opened by whichever row's Assign/Change
  // action was clicked, reusing the exact same Find Agent sheet/candidate
  // engine Monthly Planning already uses (components/find-agent-sheet.tsx).
  const [assignRequest, setAssignRequest] = useState<LiveOpsAssignRequest | null>(null);

  function loadLiveOps(forDate: string) {
    setLoading(true);
    setError(null);
    fetch(`/api/live-ops?date=${forDate}`)
      .then((r) => r.json())
      .then((data: LiveOpsView) => setView(data))
      .catch(() => setError("Could not load Live Operations for this date."))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadLiveOps(date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  function handleConflictStateChange(flightId: string, active: boolean) {
    setActiveConflictFlightIds((prev) => {
      const next = new Set(prev);
      if (active) next.add(flightId);
      else next.delete(flightId);
      return next;
    });
  }

  const sortedFlights = view?.flights
    ? [...view.flights].sort((a, b) => a.effectiveDeparture.localeCompare(b.effectiveDeparture))
    : [];

  // "Now," computed once per page load/refresh -- not a ticking clock (a
  // reasonable future enhancement, not needed for this demo). Only
  // meaningful when the viewed date actually IS today; otherwise a live
  // phase would be fabricated for a day that isn't actually happening
  // right now, so FlightOpsRow gets null instead.
  const today = todayISO();
  const isToday = date === today;
  const nowMinutesSinceMidnight = isToday ? (() => {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  })() : null;
  const dayRelation: DayRelation = date < today ? "past" : date > today ? "future" : "today";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Live Operations</h1>
          <p className="text-muted mt-1">Today&apos;s operation, scan and act — the same plan Monthly Planning currently holds.</p>
        </div>
        <label className="text-sm text-ink flex items-center gap-2">
          Date
          <input
            type="date"
            className="border border-border rounded-lg px-3 py-1.5 text-sm"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
      </div>

      {error && (
        <p className="text-sm text-bad-700 bg-bad-50 border border-bad-500/30 rounded-lg px-3 py-2">{error}</p>
      )}

      {loading && <p className="text-sm text-muted">Loading…</p>}

      {!loading && view && view.plan === null && (
        <Card className="text-sm text-ink">
          No plan exists for this date yet — generate one in Monthly Planning first.
        </Card>
      )}

      {!loading && view && view.plan !== null && sortedFlights.length === 0 && (
        <Card className="text-sm text-muted">No flights scheduled for this date.</Card>
      )}

      {!loading && view && view.plan !== null && sortedFlights.length > 0 && (
        <div className="flex flex-col gap-3">
          {sortedFlights.map((f) => (
            <FlightOpsRow
              key={f.flight.id}
              view={f}
              state={deriveFlightState(f, activeConflictFlightIds.has(f.flight.id))}
              nowMinutesSinceMidnight={nowMinutesSinceMidnight}
              dayRelation={dayRelation}
              onEdit={() => setEditing(f)}
              onRequestAssign={setAssignRequest}
            />
          ))}
        </div>
      )}

      {editing && (
        <EditFlightDrawer
          flight={editing.flight}
          effectiveDeparture={editing.effectiveDeparture}
          onClose={() => setEditing(null)}
          onSaved={() => loadLiveOps(date)}
          onConflictStateChange={handleConflictStateChange}
        />
      )}

      {assignRequest && (
        <FindAgentSheet
          requirementId={assignRequest.requirementId}
          mode={assignRequest.mode}
          roleLabel={assignRequest.roleLabel}
          replacingEmployeeId={assignRequest.mode === "reassign" ? assignRequest.employeeId : undefined}
          replacingEmployeeName={assignRequest.mode === "reassign" ? assignRequest.employeeName : undefined}
          onClose={() => setAssignRequest(null)}
          onAssigned={() => loadLiveOps(date)}
        />
      )}
    </div>
  );
}
