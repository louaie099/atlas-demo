"use client";

import { useCallback, useEffect, useState } from "react";
import { ZoneCoverageView } from "@/lib/planning/persisted-plan-view";
import { CHECKIN_ZONES } from "@/lib/checkin-zones";
import { dayOfWeekFor, weekStartFor, todayISO } from "@/lib/flight-date";
import { ROLE_HEADER, canManageOperations } from "@/lib/roles";
import { T1CapacityMap } from "./t1-capacity-map";
import { ZoneFindAgentSheet } from "./zone-find-agent-sheet";
import { AgentLink } from "./entity-panel";
import { useRole } from "./role-context";
import { Button } from "./ui";

/**
 * T1 check-in in Live Operations: the regulator sees today's per-zone
 * capacity through the day and manages it counter by counter — click a
 * counter to assign an available agent to it, or release an agent that was
 * pinned there. Everything flows through the same zone assign/candidates
 * routes Planning uses (role-checked server-side), so every change lands in
 * the audit trail.
 */
export function LiveT1Panel({ date }: { date: string }) {
  const { role } = useRole();
  const allowed = canManageOperations(role);
  const [views, setViews] = useState<ZoneCoverageView[] | null>(null);
  const [selected, setSelected] = useState<{ view: ZoneCoverageView; counter: number; occupant: { id: string; name: string } | null } | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/planning/weekly-view?week_start=${weekStartFor(date)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const day = dayOfWeekFor(date);
        setViews(((d.zoneCoverage as ZoneCoverageView[]) ?? []).filter((v) => v.dayOfWeek === day));
      })
      .catch(() => setViews([]));
  }, [date]);
  useEffect(load, [load]);

  async function release() {
    if (!selected?.occupant) return;
    const zoneRequirementId = selected.view.zoneRequirementId ?? selected.view.id;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/checkin-zone-assign", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", [ROLE_HEADER]: role },
        body: JSON.stringify({ zoneRequirementId, employeeId: selected.occupant.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not release the agent.");
        return;
      }
      setSelected(null);
      load();
    } catch {
      setError("Could not reach the server — nothing changed.");
    } finally {
      setBusy(false);
    }
  }

  if (!views) return null;
  if (views.length === 0) {
    return (
      <section className="mb-4 rounded-xl border border-border bg-white p-4">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">T1 Check-in</p>
        <p className="mt-1 text-sm text-muted">
          No T1 check-in demand for {date}: no published plan covers this week, or no flight with check-in open. Generate the weekly plan in Planning to see the counter map.
        </p>
      </section>
    );
  }
  const isToday = date === todayISO();
  const now = new Date();
  const nowSlot = now.getHours() * 60 + now.getMinutes();

  return (
    <>
      <T1CapacityMap
        views={views}
        day={isToday ? "Today" : undefined}
        initialMinutes={isToday ? nowSlot - (nowSlot % 30) : undefined}
        onCounterClick={(t) => {
          setError(null);
          setSelected(t);
        }}
      />

      {selected && !assigning && (
        <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-black/30" onClick={() => setSelected(null)} />
          <div className="relative bg-card rounded-xl2 shadow-softer border border-border w-full sm:max-w-sm m-3 p-5 flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold text-ink">Counter {selected.counter}</h2>
              <p className="text-sm text-muted">
                {CHECKIN_ZONES[selected.view.zone].label} · <span className="font-mono">{selected.view.windowStart}–{selected.view.windowEnd}</span>
              </p>
            </div>

            {selected.occupant ? (
              <p className="text-sm text-ink">
                Assigned: <AgentLink id={selected.occupant.id} name={selected.occupant.name} />
              </p>
            ) : (
              <p className="text-sm text-muted">No agent pinned to this counter for this window.</p>
            )}

            {error && <p className="text-sm text-bad-700 bg-bad-50 border border-bad-500/30 rounded-lg px-3 py-2">{error}</p>}
            {!allowed && <p className="text-xs text-muted">Read-only — switch role in Demo tools to manage counters.</p>}

            <div className="flex flex-wrap gap-2 justify-end">
              <Button variant="ghost" onClick={() => setSelected(null)}>
                Close
              </Button>
              {selected.occupant ? (
                <Button variant="secondary" onClick={release} disabled={!allowed || busy}>
                  {busy ? "Releasing…" : "Release agent"}
                </Button>
              ) : (
                <Button onClick={() => setAssigning(true)} disabled={!allowed}>
                  Assign available agent
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {selected && assigning && (
        <ZoneFindAgentSheet
          zoneRequirementId={selected.view.zoneRequirementId ?? selected.view.id}
          counter={selected.counter}
          onClose={() => {
            setAssigning(false);
            setSelected(null);
          }}
          onAssigned={() => {
            setAssigning(false);
            setSelected(null);
            load();
          }}
        />
      )}
    </>
  );
}
