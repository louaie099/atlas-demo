import { Button } from "./ui";

export function WeekNav({
  weekLabel,
  hasData,
  onPrev,
  onNext,
}: {
  weekLabel: string;
  hasData: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex items-center justify-between bg-white border border-border rounded-xl2 px-4 py-3 shadow-soft">
      <Button variant="ghost" onClick={onPrev}>
        ← Previous week
      </Button>
      <div className="text-center">
        <p className="font-medium text-ink">{weekLabel}</p>
        {!hasData && <p className="text-xs text-muted mt-0.5">No scheduled flights for this week yet</p>}
      </div>
      <Button variant="ghost" onClick={onNext}>
        Next week →
      </Button>
    </div>
  );
}
