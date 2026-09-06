"use client";

import { useMemo, useState } from "react";
import { AgentScheduleEntry, AgentDayEntry } from "@/lib/types";
import { Badge } from "./ui";
import { TeamBadge } from "./team-badge";
import { ROSTER_COLORS, rosterCellTone } from "@/lib/roster-colors";
import { AgentDayDetail } from "./agent-day-detail";
import { AgentScheduleFilters, AgentScheduleFilterState, EMPTY_AGENT_SCHEDULE_FILTERS } from "./agent-schedule-filters";

const DAY_SHORT: Record<string, string> = {
  Monday: "Mon",
  Tuesday: "Tue",
  Wednesday: "Wed",
  Thursday: "Thu",
  Friday: "Fri",
  Saturday: "Sat",
  Sunday: "Sun",
};

/**
 * One compact grid cell for one employee/day. Facts are composable, not a
 * single exclusive "day kind": a working day can carry a shift code AND a
 * foreign-company commitment AND one or more RAM duties AND a plan warning,
 * all at once -- each gets its own small indicator rather than one label
 * overwriting the others. ATLAS-assigned duties get the same calm brand
 * treatment used in Flight Coverage (never rendered as a warning, and
 * never labeled "proposed" -- an ordinary generated duty is a normal
 * assignment, not a pending recommendation); a real plan warning gets its
 * own separate, honestly-colored indicator.
 */
function DayCell({ day, onClick }: { day: AgentDayEntry; onClick: () => void }) {
  if (day.status === "off") {
    const tone = ROSTER_COLORS.off;
    return (
      <button
        type="button"
        onClick={onClick}
        className={`w-full h-full min-w-[104px] px-2.5 py-2 text-center text-xs font-medium rounded-lg ${tone.bg} ${tone.text} hover:brightness-95`}
      >
        OFF
      </button>
    );
  }

  const confirmedCount = day.duties.filter((d) => d.status === "confirmed").length;
  const assignedCount = day.duties.filter((d) => d.status === "assigned").length;
  const hasIssue = day.issues.length > 0;
  const tone = rosterCellTone(day.shiftCode);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full h-full min-w-[104px] px-2.5 py-2 text-left rounded-lg flex flex-col gap-0.5 ${tone.bg} hover:brightness-95`}
    >
      <div className="flex items-center gap-1.5">
        <span className={`text-xs font-semibold ${tone.text}`}>{day.shiftCode ?? "—"}</span>
        {hasIssue && (
          <span title="Plan warning this day" className={`${ROSTER_COLORS.warning} text-xs leading-none`}>
            ⚠
          </span>
        )}
      </div>
      {day.shiftStart && day.shiftEnd && (
        <span className="text-[10.5px] text-muted leading-tight">
          {day.shiftStart}–{day.shiftEnd}
        </span>
      )}
      {day.foreignCommitments.length > 0 && (
        <span className="text-[10.5px] leading-tight">
          <TeamBadge name={day.foreignCommitments[0].airline} />
        </span>
      )}
      {(confirmedCount > 0 || assignedCount > 0) && (
        <span className={`text-[10.5px] leading-tight ${assignedCount > 0 ? ROSTER_COLORS.assignedDuty : ROSTER_COLORS.confirmedDuty}`}>
          {confirmedCount + assignedCount} {confirmedCount + assignedCount === 1 ? "duty" : "duties"}
          {/* Both counts are real, current duties -- "confirmed" (backed by
              a real Assignment row) is the notable exception worth calling
              out; the ordinary ATLAS-assigned case needs no extra label. */}
          {assignedCount > 0 && confirmedCount > 0 ? ` (${confirmedCount} confirmed)` : ""}
        </span>
      )}
    </button>
  );
}

function AgentRow({
  entry,
  onOpenDay,
}: {
  entry: AgentScheduleEntry;
  onOpenDay: (entry: AgentScheduleEntry, day: AgentDayEntry) => void;
}) {
  return (
    <tr className="border-b border-border last:border-0">
      <td className="sticky left-0 z-10 bg-card px-3 py-1.5 align-top border-r border-border">
        <div className="flex flex-col gap-0.5 min-w-[168px] max-w-[200px]">
          <span className="text-sm font-medium text-ink truncate">{entry.employee.name}</span>
          <TeamBadge name={entry.employee.assignment} />
          {entry.weeklyIssues.length > 0 && (
            <span title={entry.weeklyIssues.map((i) => i.description).join(" ")} className={`text-[10.5px] ${ROSTER_COLORS.warning}`}>
              {/* Covers weekly_hours_violation AND consecutive_off_violation
                  — both are week-level (no single dayOfWeek), so the label
                  stays generic rather than naming only one of them. */}
              ⚠ Weekly issue
            </span>
          )}
        </div>
      </td>
      {entry.days.map((day) => (
        <td key={day.dayOfWeek} className="px-1 py-1 align-top">
          <DayCell day={day} onClick={() => onOpenDay(entry, day)} />
        </td>
      ))}
    </tr>
  );
}

export function AgentScheduleTable({ schedule }: { schedule: AgentScheduleEntry[] }) {
  const [filters, setFilters] = useState<AgentScheduleFilterState>(EMPTY_AGENT_SCHEDULE_FILTERS);
  const [selected, setSelected] = useState<{ entry: AgentScheduleEntry; day: AgentDayEntry } | null>(null);

  const daysOrder = schedule[0]?.days.map((d) => d.dayOfWeek) ?? [];

  const allSkills = useMemo(() => {
    const s = new Set<string>();
    for (const entry of schedule) for (const skill of entry.employee.skills) s.add(skill);
    return Array.from(s).sort();
  }, [schedule]);

  const filtered = useMemo(() => {
    return schedule.filter((entry) => {
      const e = entry.employee;
      if (filters.search && !e.name.toLowerCase().includes(filters.search.toLowerCase())) return false;
      if (filters.team && e.assignment !== filters.team) return false;
      if (filters.skill && !e.skills.includes(filters.skill)) return false;
      if (filters.shift) {
        const matchesShift = entry.days.some((d) => (filters.shift === "OFF" ? d.status === "off" : d.shiftCode === filters.shift));
        if (!matchesShift) return false;
      }
      if (filters.status === "plan_warning") {
        const hasWarning = entry.weeklyIssues.length > 0 || entry.days.some((d) => d.issues.length > 0);
        if (!hasWarning) return false;
      }
      if (filters.status === "foreign_commitment") {
        if (!entry.days.some((d) => d.foreignCommitments.length > 0)) return false;
      }
      if (filters.status === "assigned_duty") {
        if (!entry.days.some((d) => d.duties.some((duty) => duty.status === "assigned"))) return false;
      }
      return true;
    });
  }, [schedule, filters]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <AgentScheduleFilters filters={filters} onChange={setFilters} allSkills={allSkills} />
        <span className="text-xs text-muted whitespace-nowrap">
          {filtered.length} of {schedule.length} employees
        </span>
      </div>

      <div className="bg-card border border-border rounded-xl2 shadow-soft overflow-hidden">
        <div className="overflow-auto" style={{ maxHeight: "70vh" }}>
          <table className="border-collapse text-sm w-full">
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-30 bg-card px-3 py-2 text-left text-xs uppercase text-muted border-b border-r border-border">
                  Employee
                </th>
                {daysOrder.map((day) => (
                  <th
                    key={day}
                    className="sticky top-0 z-20 bg-card px-2.5 py-2 text-left text-xs uppercase text-muted border-b border-border min-w-[104px]"
                  >
                    {DAY_SHORT[day] ?? day}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((entry) => (
                <AgentRow key={entry.employee.id} entry={entry} onOpenDay={(e, d) => setSelected({ entry: e, day: d })} />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={() => setSelected(null)}>
          <div
            className="w-full max-w-md h-full bg-card shadow-soft overflow-y-auto p-5 flex flex-col gap-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold text-ink">{selected.entry.employee.name}</h3>
                <div className="flex items-center gap-2 mt-1">
                  <TeamBadge name={selected.entry.employee.assignment} />
                  <Badge tone="neutral">{selected.day.dayOfWeek}</Badge>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="text-muted hover:text-ink text-sm px-2 py-1 rounded-lg hover:bg-surface"
              >
                Close
              </button>
            </div>

            <AgentDayDetail day={selected.day} />
          </div>
        </div>
      )}
    </div>
  );
}
