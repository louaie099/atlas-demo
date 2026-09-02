import { TEAMS } from "@/lib/teams";

export interface EmployeeFilterState {
  search: string;
  team: string;
  skill: string;
  status: string;
}

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
        className="border border-border rounded-lg px-3 py-1.5 text-sm w-48"
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
        {TEAMS.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
        <option value="__foreign__">Any foreign company</option>
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
        value={filters.status}
        onChange={(e) => onChange({ ...filters, status: e.target.value })}
      >
        <option value="">Any status</option>
        <option value="on_duty">On Duty</option>
        <option value="off">Off</option>
        <option value="committed">Committed (foreign)</option>
        <option value="transit">Transit</option>
      </select>
      {(filters.search || filters.team || filters.skill || filters.status) && (
        <button
          className="text-xs text-muted hover:text-ink underline"
          onClick={() => onChange({ search: "", team: "", skill: "", status: "" })}
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
