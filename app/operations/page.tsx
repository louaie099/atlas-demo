"use client";

import { useEffect, useState } from "react";
import { todayISO } from "@/lib/flight-date";
import { LiveOpsFlightView, LiveOpsImpact, LiveOpsView } from "@/lib/live-ops-service";
import { deriveFlightState, LiveOpsFlightState } from "@/lib/live-ops-flight-state";
import { BOARD_SECTION_LABEL, BoardSection, groupFlights } from "@/lib/live-ops-board";
import { buildDelayImpactNotification, LiveOpsNotification } from "@/lib/live-ops-notifications";
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

  // Notification/Attention Center — client-side/in-memory for this pass
  // (see lib/live-ops-notifications.ts's own doc comment on why).
  const [notifications, setNotifications] = useState<LiveOpsNotification[]>([]);
  const [toast, setToast] = useState<LiveOpsNotification | null>(null);

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

  function handleNotify(impact: LiveOpsImpact) {
    const notification = buildDelayImpactNotification(impact.flight, impact);
    if (!notification) return;
    setNotifications((prev) => [notification, ...prev]);
    setToast(notification);
  }

  function openFlight(flightId: string, requirementId?: string) {
    setOpenFlightId(flightId);
    setFocusRequirementId(requirementId);
  }

  function handleNotificationOpen(notification: LiveOpsNotification) {
    setNotifications((prev) => prev.map((n) => (n.id === notification.id ? { ...n, state: "acknowledged" } : n)));
    openFlight(notification.flightId, notification.requirementIds[0]);
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
              <NotificationCenter notifications={notifications} onOpen={handleNotificationOpen} />
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
          onNotify={handleNotify}
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
          notification={toast}
          onView={() => {
            handleNotificationOpen(toast);
            setToast(null);
          }}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  );
}
