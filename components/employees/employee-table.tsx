"use client";

import { useState } from "react";
import { Employee } from "@/lib/types";
import { Badge } from "@/components/ui";
import { TeamBadge } from "@/components/team-badge";
import { getTeamColor } from "@/lib/team-colors";
import { OPERATIONAL_PLACEMENTS } from "@/lib/teams";

interface EnrichedEmployee extends Employee {
  today: {
    status: "off" | "not_rostered" | "committed" | "transit" | "on_duty";
    shiftCode: string | null;
    foreignCommitment: { airline: string } | null;
  };
}

const statusLabel: Record<string, string> = {
  on_duty: "On Duty",
  off: "Off",
  not_rostered: "Not Rostered",
  transit: "Transit",
  committed: "Committed",
};

const statusTone: Record<string, "good" | "neutral" | "warn"> = {
  on_duty: "good",
  off: "neutral",
  not_rostered: "neutral",
  transit: "warn",
  committed: "warn",
};

function slugifyTeam(name: string): string {
  return `team-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`;
}

function EmployeeRow({
  e,
  onSelect,
  showTeam,
  showHours,
}: {
  e: EnrichedEmployee;
  onSelect: (id: string) => void;
  showTeam: boolean;
  showHours: boolean;
}) {
  return (
    <tr onClick={() => onSelect(e.id)} className="border-b border-border last:border-0 cursor-pointer hover:bg-surface">
      <td className="px-4 py-3 font-medium text-ink whitespace-nowrap">
        <div className="flex items-center gap-2">
          {e.name}
          {e.is_duty_officer && <Badge tone="brand">Duty Officer</Badge>}
        </div>
      </td>
      {showTeam && (
        <td className="px-4 py-3 whitespace-nowrap">
          <TeamBadge name={e.assignment} />
        </td>
      )}
      <td className="px-4 py-3 whitespace-nowrap text-muted">
        {e.today.shiftCode ?? (e.today.status === "not_rostered" ? "Not rostered" : "—")}
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1">
          {e.skills.slice(0, 3).map((s) => (
            <span key={s} className="text-xs bg-gray-100 text-ink px-2 py-0.5 rounded-full">
              {s}
            </span>
          ))}
          {e.skills.length > 3 && <span className="text-xs text-muted">+{e.skills.length - 3}</span>}
        </div>
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        <Badge tone={statusTone[e.today.status]}>
          {e.today.status === "committed" && e.today.foreignCommitment ? (
            <span className="inline-flex items-center gap-1.5">
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: getTeamColor(e.today.foreignCommitment.airline) }}
              />
              Committed · {e.today.foreignCommitment.airline}
            </span>
          ) : (
            statusLabel[e.today.status]
          )}
        </Badge>
      </td>
      {showHours && (
        <td className="px-4 py-3 whitespace-nowrap">
          {e.weekly_hours === null ? (
            <span className="text-muted">—</span>
          ) : (
            <Badge tone={e.weekly_hours >= 35 ? "warn" : "neutral"}>{e.weekly_hours}h</Badge>
          )}
        </td>
      )}
    </tr>
  );
}

function TableHead({ showTeam, showHours }: { showTeam: boolean; showHours: boolean }) {
  return (
    <thead>
      <tr className="text-left text-xs uppercase text-muted border-b border-border">
        <th className="px-4 py-3">Employee</th>
        {showTeam && <th className="px-4 py-3">Team</th>}
        <th className="px-4 py-3">Shift Today</th>
        <th className="px-4 py-3">Qualifications</th>
        <th className="px-4 py-3">Status</th>
        {showHours && <th className="px-4 py-3">Weekly Hours</th>}
      </tr>
    </thead>
  );
}

/**
 * Employees, grouped by team -- the default view (2026-10-23 product
 * decision: simple team-based navigation beats one long flat list once a
 * roster grows past a handful of people). Groups follow
 * OPERATIONAL_PLACEMENTS's canonical order (internal RAM services, then
 * foreign companies), each a collapsible section with a jump-to chip
 * above the table so a Duty Officer scanning for "who's on Transit" never
 * has to scroll past every other team first. Collapsed/expanded state is
 * per-team and resets on every filter change -- deliberately not
 * persisted, since which team matters changes constantly shift to shift.
 *
 * showHours is computed once, across the FULL filtered list, by the
 * parent EmployeeTable -- never recomputed per group -- so every team's
 * section shows (or hides) the Weekly Hours column consistently, instead
 * of the column flickering in and out between sections depending on
 * which few employees happen to land in each one.
 */
function GroupedEmployeeTable({
  employees,
  onSelect,
  showHours,
}: {
  employees: EnrichedEmployee[];
  onSelect: (id: string) => void;
  showHours: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const groups = OPERATIONAL_PLACEMENTS.map((team) => ({
    team,
    members: employees.filter((e) => e.assignment === team),
  })).filter((g) => g.members.length > 0);

  // Defensive -- an assignment that somehow isn't in OPERATIONAL_PLACEMENTS
  // (shouldn't happen; every real team/company is listed there) still gets
  // shown rather than silently dropped.
  const grouped = new Set(groups.flatMap((g) => g.members.map((m) => m.id)));
  const other = employees.filter((e) => !grouped.has(e.id));
  if (other.length > 0) groups.push({ team: "Other", members: other });

  function scrollToTeam(team: string) {
    const el = document.getElementById(slugifyTeam(team));
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    setCollapsed((c) => ({ ...c, [team]: false }));
  }

  if (employees.length === 0) {
    return (
      <div className="bg-card border border-border rounded-xl2 shadow-soft px-4 py-8 text-center text-muted text-sm">
        No employees match these filters.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {groups.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {groups.map(({ team, members }) => (
            <button
              key={team}
              onClick={() => scrollToTeam(team)}
              className="inline-flex items-center gap-1.5 text-xs bg-white border border-border rounded-full px-2.5 py-1 hover:bg-surface"
            >
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: team === "Other" ? "#9CA3AF" : getTeamColor(team) }}
              />
              {team}
              <span className="text-muted">{members.length}</span>
            </button>
          ))}
        </div>
      )}

      {groups.map(({ team, members }) => {
        const isCollapsed = collapsed[team];
        return (
          <div key={team} id={slugifyTeam(team)} className="bg-card border border-border rounded-xl2 shadow-soft overflow-hidden scroll-mt-4">
            <button
              onClick={() => setCollapsed((c) => ({ ...c, [team]: !c[team] }))}
              className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-surface"
            >
              <span className="inline-flex items-center gap-2 font-medium text-ink">
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: team === "Other" ? "#9CA3AF" : getTeamColor(team) }}
                />
                {team}
                <span className="text-muted font-normal text-sm">
                  {members.length} employee{members.length === 1 ? "" : "s"}
                </span>
              </span>
              <span className="text-muted text-sm">{isCollapsed ? "Show" : "Hide"}</span>
            </button>
            {!isCollapsed && (
              <div className="overflow-x-auto border-t border-border">
                <table className="w-full text-sm">
                  <TableHead showTeam={false} showHours={showHours} />
                  <tbody>
                    {members.map((e) => (
                      <EmployeeRow key={e.id} e={e} onSelect={onSelect} showTeam={false} showHours={showHours} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FlatEmployeeTable({
  employees,
  onSelect,
  showHours,
}: {
  employees: EnrichedEmployee[];
  onSelect: (id: string) => void;
  showHours: boolean;
}) {
  const sorted = [...employees].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="bg-card border border-border rounded-xl2 shadow-soft overflow-x-auto">
      <table className="w-full text-sm">
        <TableHead showTeam showHours={showHours} />
        <tbody>
          {sorted.map((e) => (
            <EmployeeRow key={e.id} e={e} onSelect={onSelect} showTeam showHours={showHours} />
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={showHours ? 6 : 5} className="px-4 py-8 text-center text-muted">
                No employees match these filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function EmployeeTable({
  employees,
  onSelect,
  groupByTeam,
}: {
  employees: EnrichedEmployee[];
  onSelect: (id: string) => void;
  groupByTeam: boolean;
}) {
  // The seed data gives every agent the same weekly_hours, which reads as a
  // placeholder rather than information -- show the column only when the
  // values actually differ between agents. Computed once here, across the
  // FULL (filtered, ungrouped) list, so grouped mode's per-team sections
  // never disagree with each other about whether this column exists.
  const showHours = new Set(employees.map((e) => e.weekly_hours)).size > 1;

  return groupByTeam ? (
    <GroupedEmployeeTable employees={employees} onSelect={onSelect} showHours={showHours} />
  ) : (
    <FlatEmployeeTable employees={employees} onSelect={onSelect} showHours={showHours} />
  );
}
