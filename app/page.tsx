"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AuditLogEntry } from "@/lib/types";
import { todayISO } from "@/lib/flight-date";
import { LiveOpsFlightView, LiveOpsView } from "@/lib/live-ops-service";
import { deriveFlightState, LiveOpsFlightState } from "@/lib/live-ops-flight-state";
import { FLIGHT_PHASE_LABEL, resolveFlightPhase } from "@/lib/flight-phase";
import { OperationalAlert, reconcileAlerts } from "@/lib/live-ops-alerts";
import { attentionStateFor } from "@/lib/live-ops-board";
import { auditTag, tidyAuditText } from "@/lib/audit-format";
import { KpiCard } from "@/components/kpi-card";
import { Card, Badge, Button, PageHeader } from "@/components/ui";
import { FindAgentSheet } from "@/components/find-agent-sheet";
import { AgentLink, FlightLink, LinkedText, flightHref } from "@/components/entity-panel";

/**
 * COMMAND CENTER (2026-10-21 redesign) — replaces the old Dashboard.
 *
 * The old Dashboard read /api/roster, which is pinned to the fixed seed
 * week (lib/seed-data.ts's CURRENT_WEEK_START), so it showed zeros for any
 * real date outside that week even though Planning and Live Operations
 * had data. This page reads the SAME source Live Operations reads
 * (GET /api/live-ops for today), so the two can never disagree, and it
 * reuses Live Operations' own alert detection (reconcileAlerts) and the
 * real Find Agent sheet for decisions — no parallel logic.
 */

const MONTH_DAY = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function parseLocalDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

const STATE_PILL: Record<LiveOpsFlightState, { label: string; tone: "good" | "warn" | "bad" }> = {
  covered: { label: "Covered", tone: "good" },
  delayed: { label: "Delayed", tone: "warn" },
  gap: { label: "Gap", tone: "bad" },
  conflict: { label: "Conflict", tone: "bad" },
};

const DOT_COLOR: Record<LiveOpsFlightState | "none" | "done", string> = {
  covered: "#0F7B53",
  delayed: "#C26A00",
  gap: "#D13B30",
  conflict: "#D13B30",
  none: "#6F7D8B",
  done: "#6F7D8B",
};

function staffingOf(view: LiveOpsFlightView) {
  const total = view.requirements.reduce((n, r) => n + r.requirement.total_requirement, 0);
  const open = view.requirements.reduce((n, r) => n + r.gap, 0);
  return { total, covered: Math.max(0, total - open) };
}

function agentsOf(view: LiveOpsFlightView): { id: string; name: string }[] {
  const seen = new Set<string>();
  const out: { id: string; name: string }[] = [];
  for (const r of view.requirements) {
    const invalid = new Set(r.invalidatedAssignments.map((i) => i.employee.id));
    for (const e of [...r.assignedEmployees, ...r.proposedEmployees]) {
      if (invalid.has(e.id) || seen.has(e.id)) continue;
      seen.add(e.id);
      out.push({ id: e.id, name: e.name });
    }
  }
  return out;
}

export default function CommandCenterPage() {
  // Resolved after mount: the server's calendar day can differ from the
  // browser's (e.g. Vercel runs in UTC), so deriving it during SSR would
  // produce a hydration mismatch around midnight.
  const [date, setDate] = useState<string | null>(null);
  useEffect(() => setDate(todayISO()), []);
  const [view, setView] = useState<LiveOpsView | null>(null);
  const [audit, setAudit] = useState<AuditLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assignRequest, setAssignRequest] = useState<{ requirementId: string; roleLabel: string } | null>(null);
  const [nowMinutes, setNowMinutes] = useState<number>(() => {
    const n = new Date();
    return n.getHours() * 60 + n.getMinutes();
  });

  const load = useCallback(() => {
    if (!date) return;
    setError(null);
    const n = new Date();
    setNowMinutes(n.getHours() * 60 + n.getMinutes());
    fetch(`/api/live-ops?date=${date}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data: LiveOpsView) => setView(data))
      .catch(() => setError("Could not load today's operations."));
    fetch("/api/audit-log", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => setAudit(data.entries ?? []))
      .catch(() => setAudit([]));
  }, [date]);

  useEffect(() => {
    load();
  }, [load]);

  // Keep "Now" and the departed/upcoming split live without a reload.
  useEffect(() => {
    const id = window.setInterval(() => {
      const n = new Date();
      setNowMinutes(n.getHours() * 60 + n.getMinutes());
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);

  const flights = useMemo(
    () => [...(view?.flights ?? [])].sort((a, b) => a.effectiveDeparture.localeCompare(b.effectiveDeparture)),
    [view]
  );

  const alerts: OperationalAlert[] = useMemo(() => {
    const sevRank = { critical: 0, warning: 1, info: 2 } as const;
    return reconcileAlerts([], flights, nowMinutes)
      .filter((a) => a.state !== "resolved")
      .sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
  }, [flights, nowMinutes]);

  // Same definition Live Operations uses for its counters (lib/live-ops-board.ts).
  const watchFlights = flights.filter(
    (f) =>
      f.requirements.length > 0 &&
      attentionStateFor(f, deriveFlightState(f, false), nowMinutes) === "delayed" &&
      !alerts.some((a) => a.flightId === f.flight.id)
  );
  const needsAction = flights.filter((f) => {
    const st = attentionStateFor(f, deriveFlightState(f, false), nowMinutes);
    return st === "gap" || st === "conflict";
  }).length;
  const attentionCount = needsAction + watchFlights.length;

  const noRequirementFlights = flights.filter((f) => f.requirements.length === 0);

  const totals = flights.reduce(
    (acc, f) => {
      const s = staffingOf(f);
      return { total: acc.total + s.total, covered: acc.covered + s.covered };
    },
    { total: 0, covered: 0 }
  );
  const departed = flights.filter(
    (f) => resolveFlightPhase(f.flight, f.effectiveDeparture, nowMinutes).phase === "departed"
  ).length;
  const workforce = view?.workforce;

  // Timeline range: 05:00 → 24:00 by default, widened only if a flight
  // leaves earlier than 05:00.
  const earliest = flights.length ? toMinutes(flights[0].effectiveDeparture) : 300;
  const lo = Math.min(300, Math.floor(earliest / 60) * 60);
  const hi = 1440;
  const pct = (mins: number) => Math.max(0, Math.min(100, ((mins - lo) / (hi - lo)) * 100));
  const nowPct = pct(nowMinutes);
  const hh = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:00`;

  const loading = view === null && !error;
  const hasPlan = view?.plan != null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Command center"
        subtitle={`Casablanca Mohammed V · Terminal 1${date ? ` · ${MONTH_DAY.format(parseLocalDate(date))}` : ""}`}
        actions={
          <>
            <span className="inline-flex items-center gap-2 min-h-[44px] px-3.5 rounded-full border border-border bg-white text-[13px] font-medium">
              <span className="w-2 h-2 rounded-full bg-good-500" aria-hidden="true" />
              Live
            </span>
            <Link
              href="/operations"
              className="inline-flex items-center min-h-[44px] px-4 rounded-lg bg-brand-600 text-white text-sm font-semibold hover:bg-brand-700 shadow-soft"
            >
              Open live operations
            </Link>
          </>
        }
      />

      {error && (
        <p className="text-sm text-bad-700 bg-bad-50 border border-bad-500/30 rounded-lg px-3 py-2">{error}</p>
      )}
      {loading && <p className="text-sm text-muted">Loading…</p>}

      {view && !hasPlan && (
        <Card className="flex flex-col gap-2">
          <h2 className="text-[17px] font-semibold">No plan for this week yet</h2>
          <p className="text-sm text-muted">
            Atlas has no staffing plan covering today. Generate one from the flight program in Planning.
          </p>
          <Link href="/planning" className="text-sm font-semibold text-brand-600 hover:underline self-start">
            Go to Planning →
          </Link>
        </Card>
      )}

      {view && hasPlan && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiCard
              label="Flights today"
              value={flights.length}
              sub={`${departed} departed · ${flights.length - departed} upcoming`}
            />
            <KpiCard
              label="Positions covered"
              value={totals.total === 0 ? "—" : `${totals.covered}/${totals.total}`}
              sub={totals.total - totals.covered > 0 ? `${totals.total - totals.covered} open` : "No open positions"}
              tone={totals.total - totals.covered > 0 ? "warn" : "good"}
            />
            <KpiCard
              label="Agents available"
              value={workforce?.availableToday ?? "—"}
              sub={`of ${workforce?.workingToday ?? 0} working · ${workforce?.assignedToday ?? 0} assigned`}
            />
            <KpiCard
              label="Needs attention"
              value={attentionCount}
              sub={attentionCount > 0 ? `${needsAction} need action · ${watchFlights.length} at risk` : "Nothing needs you"}
              tone={attentionCount > 0 ? "warn" : "good"}
            />
          </div>

          <div className="flex flex-wrap gap-6 items-start">
            {/* ---- Flights timeline ---- */}
            <Card className="flex-[999_1_560px] min-w-0 !pb-2">
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <h2 className="text-[17px] font-semibold">Today&apos;s flights</h2>
                <span className="text-[13px] text-muted">Coverage per flight, in time order</span>
              </div>

              {flights.length === 0 ? (
                <p className="text-sm text-muted py-6">No flights scheduled for today.</p>
              ) : (
                <div className="overflow-x-auto">
                  <div className="sm:min-w-[640px]">
                    <div className="hidden sm:grid grid-cols-[minmax(180px,240px)_minmax(140px,1fr)_120px] gap-4 pt-3.5">
                      <div />
                      <div className="relative h-[22px] font-mono text-[11px] text-muted">
                        <span className="absolute left-0 top-0">{hh(lo)}</span>
                        <span className="absolute right-0 top-0">24:00</span>
                        <span
                          className="absolute -top-0.5 -translate-x-1/2 bg-brand-600 text-white rounded-md px-2 py-px font-sans font-semibold text-[11px]"
                          style={{ left: `${nowPct}%` }}
                        >
                          Now
                        </span>
                      </div>
                      <div />
                    </div>

                    {flights.map((f) => {
                      const state = deriveFlightState(f, false);
                      const staff = staffingOf(f);
                      const noReq = f.requirements.length === 0;
                      const phase = resolveFlightPhase(f.flight, f.effectiveDeparture, nowMinutes);
                      const departedNow = phase.phase === "departed";
                      const pill = noReq ? { label: "No requirement", tone: "neutral" as const } : STATE_PILL[state];
                      const dotColor = noReq || (departedNow && state === "covered") ? DOT_COLOR.done : DOT_COLOR[state];
                      const depMin = toMinutes(f.effectiveDeparture);
                      const changed = f.effectiveDeparture !== f.flight.scheduled_departure;
                      const delayMins = changed ? depMin - toMinutes(f.flight.scheduled_departure) : 0;
                      return (
                        <div
                          key={f.flight.id}
                          className={`grid grid-cols-[1fr_auto] sm:grid-cols-[minmax(180px,240px)_minmax(140px,1fr)_120px] gap-4 items-center py-3 border-t border-border ${
                            departedNow && state === "covered" ? "opacity-60" : ""
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="flex items-baseline gap-2 flex-wrap">
                              <FlightLink flight={f.flight.flight_number} className="font-mono font-semibold text-[15px]" />
                              <span className="font-medium">{f.flight.destination ?? f.flight.route}</span>
                              <span className="text-xs text-muted">{f.flight.airline}</span>
                            </div>
                            <div className="text-xs text-muted mt-0.5">
                              <span className="sm:hidden font-mono font-semibold text-ink">{f.effectiveDeparture} · </span>
                              {(() => {
                                const agents = agentsOf(f);
                                if (agents.length === 0)
                                  return f.requirements.length === 0 ? "No staffing requirement configured" : "No one assigned yet";
                                return agents.slice(0, 3).map((a, i) => (
                                  <span key={a.id}>
                                    {i > 0 && " · "}
                                    <AgentLink id={a.id} name={a.name} />
                                  </span>
                                )).concat(agents.length > 3 ? [<span key="more"> +{agents.length - 3}</span>] : []);
                              })()}
                            </div>
                          </div>

                          <div className="relative h-7 hidden sm:block">
                            <div className="absolute left-0 right-0 top-[13px] h-0.5 bg-[#E3E8EE]" />
                            <div
                              className="absolute -top-3 -bottom-3 w-0.5 bg-brand-600 opacity-35"
                              style={{ left: `${nowPct}%` }}
                            />
                            {changed && (
                              <div
                                className="absolute top-2 w-3 h-3 rounded-full border-2 border-dashed border-[#8A97A5] bg-white box-border"
                                style={{ left: `calc(${pct(toMinutes(f.flight.scheduled_departure))}% - 6px)` }}
                              />
                            )}
                            <div
                              className="absolute top-[7px] w-3.5 h-3.5 rounded-full"
                              style={{ left: `calc(${pct(depMin)}% - 7px)`, background: dotColor }}
                            />
                            <div
                              className="absolute top-[5px] font-mono text-xs font-semibold whitespace-nowrap"
                              style={
                                pct(depMin) > 75
                                  ? { right: `calc(${100 - pct(depMin)}% + 14px)` }
                                  : { left: `calc(${pct(depMin)}% + 14px)` }
                              }
                            >
                              {f.effectiveDeparture}
                            </div>
                          </div>

                          <div className="flex flex-col items-start gap-1">
                            <Badge tone={pill.tone}>
                              {pill.label}
                              {!noReq && <span className="font-mono ml-1.5">{`${staff.covered}/${staff.total}`}</span>}
                            </Badge>
                            <span className="text-xs text-muted">
                              {FLIGHT_PHASE_LABEL[phase.phase]}
                              {delayMins > 0 ? ` · +${delayMins}m` : ""}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <p className="hidden sm:block text-xs text-muted mt-3 mb-3">
                Filled dot = current departure time · dashed ring = original time before a change
              </p>
            </Card>

            {/* ---- Decisions + activity ---- */}
            <div className="flex-[1_1_340px] min-w-0 flex flex-col gap-6">
              {alerts.length + watchFlights.length === 0 ? (
                <Card className="flex flex-col gap-3">
                  <div className="flex items-center gap-2.5">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0F7B53" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M7.5 12.5l3 3 6-6.5" />
                    </svg>
                    <h2 className="text-[17px] font-semibold">No decisions waiting</h2>
                  </div>
                  <p className="text-sm text-muted">
                    Everything is assigned. Atlas only interrupts you for exceptions such as a sick call, a delay or a
                    rest-rule conflict.
                  </p>
                  {noRequirementFlights.length > 0 && (
                    <div className="bg-warn-50 text-warn-700 rounded-lg px-3 py-2.5 text-[13px]">
                      <span className="font-bold">Config note </span>
                      {noRequirementFlights.map((f) => f.flight.flight_number).join(", ")} has no staffing requirement
                      set, so Atlas is not covering it.
                    </div>
                  )}
                </Card>
              ) : (
                <Card className="flex flex-col gap-3.5 !border-2 !border-warn-500">
                  <div className="flex items-center gap-2 text-warn-700 font-bold text-xs uppercase tracking-wider">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 3l10 18H2z" />
                      <path d="M12 10v5M12 18.2v.1" />
                    </svg>
                    Needs your decision
                  </div>
                  <div className="flex flex-col gap-3">
                    {alerts.slice(0, 3).map((a) => {
                      const fv = flights.find((f) => f.flight.id === a.flightId);
                      const reqView = fv?.requirements.find((r) => r.requirement.id === a.requirementIds[0]);
                      const best =
                        reqView?.gapResolution && reqView.gapResolution.eligible
                          ? reqView.gapResolution.candidates.find((c) => c.status === "recommended")
                          : undefined;
                      const canAssign = a.kind === "shortage" && !!reqView;
                      return (
                        <div key={a.id} className="border border-border rounded-xl p-3.5 flex flex-col gap-2">
                          <div className="flex items-start justify-between gap-2">
                            <div className="font-semibold"><LinkedText text={a.title} /></div>
                            <Badge tone={a.severity === "critical" ? "bad" : "warn"}>
                              {a.severity === "critical" ? "Critical" : "Warning"}
                            </Badge>
                          </div>
                          <p className="text-[13px] text-muted">{a.detail}</p>
                          {best && (
                            <p className="text-[13px] bg-brand-50 text-brand-700 rounded-lg px-2.5 py-1.5">
                              <span className="font-semibold">Best fit: <AgentLink id={best.employee.id} name={best.employee.name} />.</span> {best.reasoning}
                            </p>
                          )}
                          <div className="flex gap-2 flex-wrap">
                            {canAssign && reqView && (
                              <Button
                                onClick={() =>
                                  setAssignRequest({ requirementId: reqView.requirement.id, roleLabel: reqView.requirement.role })
                                }
                              >
                                Find agent
                              </Button>
                            )}
                            <Link
                              href={flightHref(a.flightNumber)}
                              className="inline-flex items-center px-4 py-2 rounded-lg text-sm font-medium border border-border bg-white hover:bg-gray-50 shadow-soft"
                            >
                              Review flight
                            </Link>
                          </div>
                        </div>
                      );
                    })}
                    {watchFlights.map((f) => (
                      <div key={`watch-${f.flight.id}`} className="border border-border rounded-xl p-3.5 flex flex-col gap-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="font-semibold">{f.flight.flight_number} — departure moved to {f.effectiveDeparture}</div>
                          <Badge tone="warn">At risk</Badge>
                        </div>
                        <p className="text-[13px] text-muted">
                          Scheduled {f.flight.scheduled_departure}. Check that the assigned agents still fit the new time.
                        </p>
                        <Link
                          href={flightHref(f.flight.flight_number)}
                          className="inline-flex items-center self-start px-4 py-2 rounded-lg text-sm font-medium border border-border bg-white hover:bg-gray-50 shadow-soft"
                        >
                          Review flight
                        </Link>
                      </div>
                    ))}
                    {alerts.length > 3 && (
                      <Link href="/operations" className="text-sm font-semibold text-brand-600 hover:underline">
                        +{alerts.length - 3} more in Live operations →
                      </Link>
                    )}
                  </div>
                  <p className="text-xs text-muted">
                    Nothing is executed until you confirm. Every decision is saved to the audit trail.
                  </p>
                </Card>
              )}

              <Card>
                <div className="flex items-baseline justify-between mb-3">
                  <h2 className="text-[17px] font-semibold">Recent activity</h2>
                  <Link href="/audit" className="text-[13px] font-semibold text-brand-600 hover:underline px-1 py-2">
                    All events
                  </Link>
                </div>
                {audit === null && <p className="text-sm text-muted">Loading…</p>}
                {audit && audit.length === 0 && <p className="text-sm text-muted">No activity yet.</p>}
                <div className="flex flex-col">
                  {[...(audit ?? [])]
                    .sort((a, b) => b.step_number - a.step_number)
                    .slice(0, 4)
                    .map((e) => {
                      const tag = auditTag(e.description);
                      return (
                        <div key={e.id} className="flex gap-3 py-2.5 border-t border-border">
                          <div className="font-mono text-xs text-muted w-[46px] shrink-0 pt-0.5">
                            {new Date(e.timestamp).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                          </div>
                          <div className="min-w-0">
                            <Badge tone={tag.tone}>{tag.label}</Badge>
                            <p className="mt-1 text-[13px]"><LinkedText text={tidyAuditText(e.description)} /></p>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </Card>
            </div>
          </div>
        </>
      )}

      {assignRequest && (
        <FindAgentSheet
          requirementId={assignRequest.requirementId}
          mode="assign"
          roleLabel={assignRequest.roleLabel}
          onClose={() => setAssignRequest(null)}
          onAssigned={() => {
            setAssignRequest(null);
            load();
          }}
        />
      )}
    </div>
  );
}
