"use client";

import { useEffect, useMemo, useState } from "react";
import { ZoneCoverageView } from "@/lib/planning/persisted-plan-view";
import { CHECKIN_ZONES, CheckinZoneId, ORDINARY_CHECKIN_ZONES } from "@/lib/checkin-zones";
import { AgentLink } from "./entity-panel";

const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

const ZONE_ORDER: CheckinZoneId[] = ["t1_italy_spain", "t1_domestic", "t1_main_checkin"];

/**
 * Counter map for T1 Check-in. Each zone is drawn as its real counter range;
 * at the selected time the first `required` counters are OPEN: filled = an
 * agent covers it, red = gap (clickable -> Find agent). Surplus agents show
 * as a "+N spare" chip. All numbers come from ZoneCoverageView (required /
 * gap / surplus) — nothing is invented here.
 */
export function T1CapacityMap({
  views,
  day,
  initialMinutes,
  compact = false,
  onFindAgent,
  onCounterClick,
}: {
  views: ZoneCoverageView[];
  day?: string;
  /** Preselected time (e.g. "now" for today); falls back to the first window. */
  initialMinutes?: number;
  compact?: boolean;
  onFindAgent?: (zoneRequirementId: string) => void;
  /** Live Operations: every OPEN counter becomes a control (assign an available agent / release one). */
  onCounterClick?: (target: { view: ZoneCoverageView; counter: number; occupant: { id: string; name: string } | null }) => void;
}) {
  const relevant = useMemo(() => views.filter((v) => v.required > 0 && ORDINARY_CHECKIN_ZONES.includes(v.zone)), [views]);
  const [min, max] = useMemo(() => {
    if (relevant.length === 0) return [5 * 60, 24 * 60];
    return [
      Math.floor(Math.min(...relevant.map((v) => toMin(v.windowStart))) / 30) * 30,
      Math.min(24 * 60, Math.ceil(Math.max(...relevant.map((v) => toMin(v.windowEnd))) / 30) * 30),
    ];
  }, [relevant]);
  const [t, setT] = useState<number>(initialMinutes ?? min);
  useEffect(() => {
    setT((cur) => {
      const base = initialMinutes ?? cur;
      return Math.min(Math.max(base, min), max - 30);
    });
  }, [min, max, initialMinutes]);

  if (relevant.length === 0) return null;

  // Worst minute of the day per slot, to colour the slider track.
  const slots: number[] = [];
  for (let m = min; m < max; m += 30) slots.push(m);
  const gapAt = (m: number) => relevant.filter((v) => toMin(v.windowStart) <= m && m < toMin(v.windowEnd)).reduce((a, v) => a + Math.max(v.gap, 0), 0);

  return (
    <section className="bg-card border border-border rounded-xl2 shadow-soft p-4 flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-ink">
          T1 check-in capacity{day ? ` · ${day}` : ""}
        </h2>
        <span className="font-mono text-lg font-semibold text-ink">{fmt(t)}</span>
      </div>

      <div>
        <div className="flex h-2 rounded-full overflow-hidden" aria-hidden="true">
          {slots.map((m) => (
            <span key={m} className={`flex-1 ${gapAt(m) > 0 ? "bg-bad-500" : "bg-brand-200"}`} />
          ))}
        </div>
        <input
          type="range"
          min={min}
          max={max - 30}
          step={30}
          value={t}
          onChange={(e) => setT(Number(e.target.value))}
          aria-label="Time of day"
          className="w-full min-h-[44px] accent-[#1F5FD1]"
        />
        <div className="flex justify-between font-mono text-xs text-muted -mt-2">
          <span>{fmt(min)}</span>
          <span>{fmt(max)}</span>
        </div>
      </div>

      <div className={`grid gap-4 ${compact ? "grid-cols-1" : "md:grid-cols-3"}`}>
        {ZONE_ORDER.map((zone) => {
          const def = CHECKIN_ZONES[zone];
          const active = relevant.filter((v) => v.zone === zone && toMin(v.windowStart) <= t && t < toMin(v.windowEnd));
          const view = active.sort((a, b) => b.required - a.required)[0];
          const total = def.counters.to - def.counters.from + 1;
          const required = view?.required ?? 0;
          const gap = Math.max(view?.gap ?? 0, 0);
          const staffed = Math.max(required - gap, 0);
          const status = !view ? "closed" : gap > 0 ? "gap" : "ok";
          const people = [...(view?.availableEmployees ?? []), ...(view?.manuallyAssignedEmployees ?? [])];
          return (
            <div key={zone} className={`rounded-xl2 border p-3 flex flex-col gap-2 ${status === "gap" ? "border-bad-500 bg-bad-50/40" : "border-border"}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-ink">{def.label.replace("T1 ", "").replace(" Check-in", "")}</div>
                  <div className="text-xs text-muted">{def.floor} · {def.countersLabel}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-lg font-semibold text-ink leading-none">
                    {staffed}/{required}
                  </div>
                  <div className="text-xs text-muted">{status === "closed" ? "no demand" : gap > 0 ? `${gap} short` : "covered"}</div>
                </div>
              </div>

              <div className="flex flex-wrap gap-1" role={onCounterClick ? "group" : "img"} aria-label={`${staffed} of ${required} open counters staffed`}>
                {(() => {
                  const manual = view?.manualCounters ?? {};
                  const byCounter = new Map<number, { id: string; name: string }>();
                  for (const e of view?.manuallyAssignedEmployees ?? []) {
                    const c = manual[e.id];
                    if (typeof c === "number") byCounter.set(c, { id: e.id, name: e.name });
                  }
                  const pinned = byCounter.size;
                  const openRest = Math.max(required - pinned, 0);
                  const filledRest = Math.max(staffed - pinned, 0);
                  let idx = 0; // position among non-pinned counters
                  return Array.from({ length: total }, (_, i) => {
                    const number = def.counters.from + i;
                    const occupant = byCounter.get(number) ?? null;
                    const open = occupant ? true : idx < openRest;
                    const filled = occupant ? true : idx < filledRest;
                    if (!occupant) idx++;
                    const cls = occupant
                      ? "border-brand-700 bg-brand-600 ring-2 ring-brand-200"
                      : !open
                        ? "border-border bg-surface"
                        : filled
                          ? "border-brand-600 bg-brand-500"
                          : "border-bad-500 bg-bad-50";
                    const label = occupant ? `Counter ${number} — ${occupant.name}` : `Counter ${number}${open ? (filled ? " — staffed" : " — open, no agent") : " — closed"}`;
                    const clickable = Boolean(view && onCounterClick);
                    if (clickable) {
                      return (
                        <button
                          key={i}
                          type="button"
                          title={label}
                          aria-label={label}
                          onClick={() => onCounterClick!({ view: view!, counter: number, occupant })}
                          className={`w-5 h-5 rounded-sm border ${cls} hover:ring-2 hover:ring-brand-500`}
                        />
                      );
                    }
                    return open && !filled && view && onFindAgent ? (
                      <button
                        key={i}
                        type="button"
                        title={`${label} — find agent`}
                        aria-label={`${label}, find agent`}
                        onClick={() => onFindAgent(view.zoneRequirementId ?? view.id)}
                        className={`w-4 h-4 rounded-sm border ${cls} hover:ring-2 hover:ring-bad-500`}
                      />
                    ) : (
                      <span key={i} title={label} className={`w-4 h-4 rounded-sm border ${cls}`} />
                    );
                  });
                })()}
              </div>

              {view && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                  <span className="font-mono">{view.windowStart}–{view.windowEnd}</span>
                  {view.surplus > 0 && <span className="rounded-full bg-brand-50 text-brand-700 px-2 py-0.5">+{view.surplus} spare</span>}
                  {!compact && people.map((e) => <AgentLink key={e.id} id={e.id} name={e.name} />)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex gap-4 text-xs text-muted flex-wrap">
        <span className="flex items-center gap-1.5"><i className="w-3 h-3 rounded-sm bg-brand-500 border border-brand-600" /> Staffed</span>
        <span className="flex items-center gap-1.5"><i className="w-3 h-3 rounded-sm bg-bad-50 border border-bad-500" /> Open, no agent</span>
        <span className="flex items-center gap-1.5"><i className="w-3 h-3 rounded-sm bg-surface border border-border" /> Closed</span>
      </div>
    </section>
  );
}
