import { TEAMS } from "@/lib/teams";
import { CONFIGURED_COMPANIES } from "@/lib/company-config";
import { SHIFT_CODES } from "@/lib/shift-templates";

export interface EmployeeFilterState {
  search: string;
  team: string;
  skill: string;
  shiftToday: string;
  status: string;
}

// Flat, operational grouping list — internal teams and foreign companies
// selectable side by side, exactly as the operator thinks about them. No
// "is this a team or a company" distinction surfaced here.
const TEAM_AND_COMPANY_OPTIONS = [...TEAMS, ...CONFIGURED_COMPANIES];

const SHIFT_CODE_OPTIONS = Object.keys(SHIFT_CODES);

export function EmployeeFilters({
  filters,
  onChange,
  allSkills,
}: {
  filters: EmployeeFilterState;
  onChange: (f: EmployeeFilterState) => void;
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
        <option value="">All teams</option>
        {TEAM_AND_COMPANY_OPTIONS.map((t) => (
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
        value={filters.shiftToday}
        onChange={(e) => onChange({ ...filters, shiftToday: e.target.value })}
      >
        <option value="">All shifts</option>
        {SHIFT_CODE_OPTIONS.map((code) => (
          <option key={code} value={code}>
            {code}
          </option>
        ))}
        <option value="OFF">OFF</option>
      </select>
      <select
        className="border border-border rounded-lg px-2.5 py-1.5 text-sm"
        value={filters.status}
        onChange={(e) => onChange({ ...filters, status: e.target.value })}
      >
        <option value="">Any status</option>
        <option value="on_duty">On Duty</option>
        <option value="off">Off</option>
        <option value="committed">Committed (foreign)</option>
        <option value="transit">Transit</option>
      </select>
      {(filters.search || filters.team || filters.skill || filters.shiftToday || filters.status) && (
        <button
          className="text-xs text-muted hover:text-ink underline"
          onClick={() => onChange({ search: "", team: "", skill: "", shiftToday: "", status: "" })}
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
