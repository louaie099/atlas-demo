import { Button } from "./ui";
import { WeekPicker } from "./week-picker";

/**
 * Previous/Next remain convenient one-week shortcuts; the week label
 * itself is now interactive (WeekPicker) so reaching a week several steps
 * away never requires clicking Next repeatedly. `weekStart` is optional
 * only so this keeps working before the very first weekly-view response
 * resolves it (see app/planning/page.tsx) -- the picker falls back to
 * today's real calendar week in that brief window.
 */
export function WeekNav({
  weekStart,
  hasData,
  onPrev,
  onNext,
  onSelectWeek,
}: {
  weekStart: string | null;
  hasData: boolean;
  onPrev: () => void;
  onNext: () => void;
  onSelectWeek: (weekStart: string) => void;
}) {
  return (
    <div className="flex items-center justify-between bg-white border border-border rounded-xl2 px-4 py-3 shadow-soft">
      <Button variant="ghost" onClick={onPrev}>
        ← Previous week
      </Button>
      <div className="text-center">
        <WeekPicker weekStart={weekStart} onSelect={onSelectWeek} />
        {!hasData && <p className="text-xs text-muted mt-0.5">No scheduled flights for this week yet</p>}
      </div>
      <Button variant="ghost" onClick={onNext}>
        Next week →
      </Button>
    </div>
  );
}
