import { OPERATIONAL_PLACEMENTS } from "@/lib/teams";
import { SHIFT_CODES } from "@/lib/shift-templates";

export interface AgentScheduleFilterState {
  search: string;
  team: string;
  skill: string;
  shift: string;
  status: string;
}

export const EMPTY_AGENT_SCHEDULE_FILTERS: AgentScheduleFilterState = {
  search: "",
  team: "",
  skill: "",
  shift: "",
  status: "",
};

const SHIFT_CODE_OPTIONS = Object.keys(SHIFT_CODES);

/**
 * Same filter-bar pattern as components/employees/employee-filters.tsx,
 * adapted for the weekly grid: "shift" matches ANY day this week (the grid
 * has 7, not 1), and "status" asks about the whole week rather than a
 * single day/moment, since the primary view is Monday-Sunday, not "today."
 */
export function AgentScheduleFilters({
  filters,
  onChange,
  allSkills,
}: {
  filters: AgentScheduleFilterState;
  onChange: (f: AgentScheduleFilterState) => void;
  allSkills: string[];
}) {
  return (
    <div className="flex flex-wrap gap-2 items-center">
      <input
        className="border border-border rounded-lg px-3 py-1.5 text-sm w-44"
        placeholder="Search name…"
        value={filters.search}
        onChange={(e) => onChange({ ...filters, search: e.target.value })}
      />
      <select
        className="border border-border rounded-lg px-2.5 py-1.5 text-sm"
        value={filters.team}
        onChange={(e) => onChange({ ...filters, team: e.target.value })}
      >
        <option value="">All teams/companies</option>
        {OPERATIONAL_PLACEMENTS.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <select
        className="border border-border rounded-lg px-2.5 py-1.5 text-sm"
        value={filters.skill}
        onChange={(e) => onChange({ ...filters, skill: e.target.value })}
      >
        <option value="">All qualifications</option>
        {allSkills.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <select
        className="border border-border rounded-lg px-2.5 py-1.5 text-sm"
        value={filters.shift}
        onChange={(e) => onChange({ ...filters, shift: e.target.value })}
        title="Matches any day this week"
      >
        <option value="">Any shift this week</option>
        {SHIFT_CODE_OPTIONS.map((code) => (
          <option key={code} value={code}>
            {code}
          </option>
        ))}
      </select>
      <select
        className="border border-border rounded-lg px-2.5 py-1.5 text-sm"
        value={filters.status}
        onChange={(e) => onChange({ ...filters, status: e.target.value })}
      >
        <option value="">Any status</option>
        <option value="plan_warning">Has a plan warning</option>
        <option value="foreign_commitment">Has a foreign-company commitment</option>
        <option value="assigned_duty">Has an ATLAS-assigned duty</option>
      </select>
      {(filters.search || filters.team || filters.skill || filters.shift || filters.status) && (
        <button
          className="text-xs text-muted hover:text-ink underline"
          onClick={() => onChange(EMPTY_AGENT_SCHEDULE_FILTERS)}
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
