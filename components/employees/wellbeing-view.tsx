"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AgentScheduleEntry } from "@/lib/types";
import { weekLabelFor, weekStartFor, todayISO } from "@/lib/flight-date";
import { computeWellbeing, NIGHT_WEIGHT_HOURS, WEEKEND_WEIGHT_HOURS } from "@/lib/wellbeing";
import { AgentLink } from "@/components/entity-panel";
import { KpiCard } from "@/components/kpi-card";
import { Badge, Card } from "@/components/ui";

const DEFAULT_MIN_REST_HOURS = 15;

/**
 * Workload & wellbeing for the current planning week -- computed from the
 * same plan the Planning page shows (see lib/wellbeing.ts for exactly what
 * each number means and what it cannot see).
 */
export function WellbeingView() {
  const [schedule, setSchedule] = useState<AgentScheduleEntry[] | null>(null);
  const [minRest, setMinRest] = useState(DEFAULT_MIN_REST_HOURS);
  const [error, setError] = useState<string | null>(null);
  const [weekStart] = useState(() => weekStartFor(todayISO()));

  useEffect(() => {
    fetch(`/api/planning/weekly-view?week_start=${weekStart}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setSchedule((d.schedule as AgentScheduleEntry[]) ?? []))
      .catch(() => setError("Could not load this week's schedule."));
    fetch("/api/planning/rules", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const h = d?.resolved?.minimumRestHours;
        if (typeof h === "number") setMinRest(h);
      })
      .catch(() => {});
  }, [weekStart]);

  const summary = useMemo(() => (schedule ? computeWellbeing(schedule, minRest) : null), [schedule, minRest]);
  const maxBurden = summary ? Math.max(1, ...summary.agents.map((a) => a.burden)) : 1;
  const rows = summary ? [...summary.agents].filter((a) => a.workedDays > 0).sort((a, b) => b.burden - a.burden) : [];

  if (error) return <p className="text-sm text-bad-700">{error}</p>;
  if (!summary) return <p className="text-sm text-muted">Loading…</p>;
  if (rows.length === 0)
    return (
      <Card className="flex flex-col gap-2">
        <h2 className="text-[17px] font-semibold">No schedule for this week yet</h2>
        <p className="text-sm text-muted">Wellbeing metrics are computed from the weekly plan. Generate one in Planning first.</p>
        <Link href="/planning" className="text-sm font-semibold text-brand-600 hover:underline self-start">
          Go to Planning →
        </Link>
      </Card>
    );

  const idx = summary.loadBalanceIndex;
  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted">{weekLabelFor(weekStart)}</p>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Load balance"
          value={idx === null ? "—" : idx}
          sub="100 = burden shared evenly"
          tone={idx === null ? "neutral" : idx >= 85 ? "good" : idx >= 70 ? "warn" : "bad"}
        />
        <KpiCard
          label="Below minimum rest"
          value={summary.agentsBelowMinRest}
          sub={`agents with under ${minRest}h between shifts`}
          tone={summary.agentsBelowMinRest > 0 ? "bad" : "good"}
        />
        <KpiCard label="Longest streak" value={`${summary.longestStreak}d`} sub="consecutive working days" tone={summary.longestStreak >= 6 ? "warn" : "neutral"} />
        <KpiCard
          label="Night shifts / agent"
          value={summary.nightsRange ? (summary.nightsRange.min === summary.nightsRange.max ? summary.nightsRange.min : `${summary.nightsRange.min}–${summary.nightsRange.max}`) : "—"}
          sub="this week, lowest to highest"
        />
      </div>

      <Card className="!p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[820px]">
            <thead>
              <tr className="text-left text-xs uppercase text-muted border-b border-border">
                <th className="px-4 py-3">Agent</th>
                <th className="px-4 py-3">Days</th>
                <th className="px-4 py-3">Hours</th>
                <th className="px-4 py-3 w-[200px]">Burden</th>
                <th className="px-4 py-3">Nights</th>
                <th className="px-4 py-3">Weekend</th>
                <th className="px-4 py-3">Streak</th>
                <th className="px-4 py-3">Min rest</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.employeeId} className="border-b border-border last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-semibold">
                      <AgentLink id={a.employeeId} name={a.name} />
                    </div>
                    <div className="text-xs text-muted">{a.team}</div>
                  </td>
                  <td className="px-4 py-3 font-mono">{a.workedDays}</td>
                  <td className="px-4 py-3 font-mono">{a.hours}h</td>
                  <td className="px-4 py-3">
                    <div className="h-2 rounded bg-[#E3E8EE] overflow-hidden">
                      <div
                        className={`h-2 rounded ${a.restBreaches > 0 ? "bg-bad-500" : "bg-brand-600"}`}
                        style={{ width: `${Math.round((a.burden / maxBurden) * 100)}%` }}
                      />
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono">{a.nights}</td>
                  <td className="px-4 py-3 font-mono">{a.weekendDays}</td>
                  <td className="px-4 py-3 font-mono">{a.longestStreak}d</td>
                  <td className="px-4 py-3 font-mono">{a.minRestHours === null ? "—" : `${a.minRestHours}h`}</td>
                  <td className="px-4 py-3">
                    {a.restBreaches > 0 ? (
                      <Badge tone="bad">Rest below {minRest}h</Badge>
                    ) : a.longestStreak >= 6 ? (
                      <Badge tone="warn">Long streak</Badge>
                    ) : (
                      <Badge tone="good">OK</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-xs text-muted max-w-3xl">
        Burden = scheduled hours + {NIGHT_WEIGHT_HOURS} h per night shift + {WEEKEND_WEIGHT_HOURS} h per weekend day. Load balance = 100 minus the
        spread of burden across agents who work this week. Computed from this week&apos;s plan only, so rest across the Sunday–Monday boundary and
        streaks that began last week are not counted.
      </p>
    </div>
  );
}
