"use client";

import { useEffect, useState } from "react";
import { todayISO } from "@/lib/flight-date";
import { LiveOpsFlightView, LiveOpsView } from "@/lib/live-ops-service";
import { deriveFlightState, LiveOpsFlightState } from "@/lib/live-ops-flight-state";
import { BOARD_SECTION_LABEL, BoardSection, groupFlights } from "@/lib/live-ops-board";
import { acknowledgeAlert, OperationalAlert, reconcileAlerts } from "@/lib/live-ops-alerts";
import { FlightOpsRow, DayRelation, LiveOpsAssignRequest } from "@/components/flight-ops-row";
import { FlightDrawer } from "@/components/flight-drawer";
import { FindAgentSheet } from "@/components/find-agent-sheet";
import { LiveOpsHeader, FlightFilter } from "@/components/live-ops-header";
import { NotificationCenter, NotificationToast } from "@/components/notification-center";
import { Card } from "@/components/ui";

const SECTION_ORDER: BoardSection[] = ["needsAttention", "upcomingActive", "normal", "completed"];

export default function OperationsPage() {
  const [date, setDate] = useState(todayISO());
  const [view, setView] = useState<LiveOpsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeConflictFlightIds, setActiveConflictFlightIds] = useState<Set<string>>(new Set());
  // The flight currently open in the drawer, plus which requirement (if
  // any) a notification click asked to focus — cleared whenever the
  // drawer closes or the board reloads to a different flight.
  const [openFlightId, setOpenFlightId] = useState<string | null>(null);
  const [focusRequirementId, setFocusRequirementId] = useState<string | undefined>(undefined);
  // Every staffing requirement row must be actionable (2026-10-04): a
  // single shared sheet instance, opened by whichever row's Assign/Change
  // action was clicked, reusing the exact same Find Agent sheet/candidate
  // engine Monthly Planning already uses (components/find-agent-sheet.tsx).
  const [assignRequest, setAssignRequest] = useState<LiveOpsAssignRequest | null>(null);
  const [filter, setFilter] = useState<FlightFilter>("all");

  // Attention Center (Live Operations phase 2) — reconciled from the live
  // view on every refresh (see lib/live-ops-alerts.ts's own doc comment
  // for the full lifecycle: detection never depends on this drawer, or
  // any drawer, having been opened). Still client-side/in-memory for this
  // pass — a genuinely open problem is re-detected from the live data on
  // every fetch, so a page reload can never make it look resolved; see
  // APPLY_NOTES for the one trade-off this leaves (an "acknowledged"
  // marker doesn't survive a hard reload) and the smallest follow-up that
  // would close it.
  const [alerts, setAlerts] = useState<OperationalAlert[]>([]);
  const [toast, setToast] = useState<OperationalAlert | null>(null);

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

  function openFlight(flightId: string, requirementId?: string) {
    setOpenFlightId(flightId);
    setFocusRequirementId(requirementId);
  }

  function handleAlertOpen(alert: OperationalAlert) {
    setAlerts((prev) => acknowledgeAlert(prev, alert.id));
    openFlight(alert.flightId, alert.requirementIds[0]);
  }

  const allFlights = view?.flights ?? [];
  const states = new Map<string, LiveOpsFlightState>(
    allFlights.map((f) => [f.flight.id, deriveFlightState(f, activeConflictFlightIds.has(f.flight.id))])
  );
  const stateFor = (v: LiveOpsFlightView) => states.get(v.flight.id) ?? "covered";

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

  // Re-derive the Attention Center every time the board data itself
  // changes -- the regulator saving a flight edit (onSaved), confirming a
  // replacement (onAssigned), or simply switching dates all call
  // loadLiveOps, which lands here; there is no separate polling
  // mechanism, matching section 6's "use the application's existing
  // refresh mechanisms."
  useEffect(() => {
    if (!view) return;
    setAlerts((prev) => {
      const next = reconcileAlerts(prev, view.flights, nowMinutesSinceMidnight);
      // A toast fires only for an alert that is genuinely new THIS
      // refresh (first-ever detection, or a real reappearance after
      // resolution) — never for one that was already open, so saving an
      // unrelated flight never re-pops a toast for an existing problem
      // (section 7: avoid overwhelming the regulator with repeated
      // alerts for the same flight).
      const prevByFlight = new Map(prev.map((a) => [a.flightId, a]));
      const freshlyNew = next.find((a) => {
        const was = prevByFlight.get(a.flightId);
        return a.state === "new" && (!was || was.state === "resolved");
      });
      if (freshlyNew) setToast(freshlyNew);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const filtered = allFlights.filter((f) => {
    if (filter === "all") return true;
    const s = stateFor(f);
    if (filter === "covered") return s === "covered";
    if (filter === "atRisk") return s === "delayed";
    if (filter === "needsAction") return s === "gap" || s === "conflict";
    return true;
  });
  const sortedFiltered = [...filtered].sort((a, b) => a.effectiveDeparture.localeCompare(b.effectiveDeparture));
  const grouped = groupFlights(sortedFiltered, stateFor, nowMinutesSinceMidnight);

  const openFlightView = openFlightId ? allFlights.find((f) => f.flight.id === openFlightId) ?? null : null;

  return (
    <div className="flex flex-col gap-6">
      {view && (
        <LiveOpsHeader
          date={date}
          view={view}
          states={allFlights.map(stateFor)}
          activeFilter={filter}
          onFilterChange={setFilter}
          rightSlot={
            <div className="flex items-center gap-3">
              <label className="text-sm text-ink flex items-center gap-2">
                Date
                <input
                  type="date"
                  className="border border-border rounded-lg px-3 py-1.5 text-sm"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </label>
              <NotificationCenter alerts={alerts} onOpen={handleAlertOpen} />
            </div>
          }
        />
      )}

      {error && (
        <p className="text-sm text-bad-700 bg-bad-50 border border-bad-500/30 rounded-lg px-3 py-2">{error}</p>
      )}

      {loading && <p className="text-sm text-muted">Loading…</p>}

      {!loading && view && view.plan === null && (
        <Card className="text-sm text-ink">
          No planning available for this date — generate one in Monthly Planning first.
        </Card>
      )}

      {!loading && view && view.plan !== null && allFlights.length === 0 && (
        <Card className="text-sm text-muted">No flights scheduled for this date.</Card>
      )}

      {!loading && view && view.plan !== null && allFlights.length > 0 && (
        <div className="flex flex-col gap-6">
          {SECTION_ORDER.map((section) => {
            const sectionFlights = grouped[section];
            if (sectionFlights.length === 0) return null;
            return (
              <div key={section} className="flex flex-col gap-3">
                <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">
                  {BOARD_SECTION_LABEL[section]} <span className="text-muted">({sectionFlights.length})</span>
                </h2>
                {sectionFlights.map((f) => (
                  <FlightOpsRow
                    key={f.flight.id}
                    view={f}
                    state={stateFor(f)}
                    nowMinutesSinceMidnight={nowMinutesSinceMidnight}
                    dayRelation={dayRelation}
                    onEdit={() => openFlight(f.flight.id)}
                    onOpen={() => openFlight(f.flight.id)}
                    onOpenRequirement={(requirementId) => openFlight(f.flight.id, requirementId)}
                    onRequestAssign={setAssignRequest}
                  />
                ))}
              </div>
            );
          })}
          {sortedFiltered.length === 0 && (
            <Card className="text-sm text-muted">No flights match this filter.</Card>
          )}
        </div>
      )}

      {openFlightView && (
        <FlightDrawer
          view={openFlightView}
          focusRequirementId={focusRequirementId}
          onClose={() => {
            setOpenFlightId(null);
            setFocusRequirementId(undefined);
          }}
          onSaved={() => loadLiveOps(date)}
          onConflictStateChange={handleConflictStateChange}
          onRequestAssign={setAssignRequest}
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

      {toast && (
        <NotificationToast
          alert={toast}
          onView={() => {
            handleAlertOpen(toast);
            setToast(null);
          }}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  );
}
