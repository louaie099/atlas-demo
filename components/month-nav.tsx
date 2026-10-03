import { weekRangeLabelFor } from "@/lib/flight-date";
import { Button } from "./ui";
import { MonthPicker } from "./month-picker";

/**
 * Monthly Planning's top-level navigation (2026-10-03): the month is now
 * the planning HORIZON (Previous/Next month + a direct month picker), with
 * the weeks inside it shown as a compact row of inspection tabs underneath
 * -- never a single giant month-wide table (see the product doc comment on
 * app/planning/page.tsx). Selecting a week here still just calls
 * onSelectWeek(weekStart) -- the exact same callback that used to come
 * from WeekNav/WeekPicker -- so every existing week-scoped fetch/action on
 * the page (Flight Schedule, Flight Coverage, Agent Schedule, Make
 * Planning, Import/Add Flight, Find Agent) is completely unaffected by
 * this restructure; weekStart remains the one real unit of work.
 *
 * `weeksInMonth` is computed by the caller (lib/flight-date.ts's
 * weeksOverlappingMonth) rather than here, so this component stays a pure
 * presentational layer, matching WeekNav/WeekPicker's own existing split.
 */
export function MonthNav({
  monthStart,
  weekStart,
  weeksInMonth,
  hasData,
  onSelectMonth,
  onPrevMonth,
  onNextMonth,
  onSelectWeek,
}: {
  monthStart: string | null;
  weekStart: string | null;
  weeksInMonth: string[];
  hasData: boolean;
  onSelectMonth: (monthStart: string) => void;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onSelectWeek: (weekStart: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between bg-white border border-border rounded-xl2 px-4 py-3 shadow-soft">
        <Button variant="ghost" onClick={onPrevMonth}>
          ← Previous month
        </Button>
        <MonthPicker monthStart={monthStart} onSelect={onSelectMonth} />
        <Button variant="ghost" onClick={onNextMonth}>
          Next month →
        </Button>
      </div>

      {weeksInMonth.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="flex gap-1 bg-white border border-border rounded-xl2 p-1 overflow-x-auto">
            {weeksInMonth.map((w, i) => (
              <button
                key={w}
                onClick={() => onSelectWeek(w)}
                className={`flex-1 min-w-[7.5rem] text-center px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap ${
                  w === weekStart ? "bg-brand-50 text-brand-700" : "text-muted hover:text-ink"
                }`}
                title={weekRangeLabelFor(w)}
              >
                Week {i + 1}
                <span className="block text-xs font-normal opacity-80">{weekRangeLabelFor(w)}</span>
              </button>
            ))}
          </div>
          {!hasData && <p className="text-xs text-muted text-center">No scheduled flights for this week yet</p>}
        </div>
      )}
    </div>
  );
}
