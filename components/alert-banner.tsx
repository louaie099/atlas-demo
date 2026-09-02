export function AlertBanner({
  employeeName,
  task,
  overlapMinutes,
}: {
  employeeName: string;
  task: string;
  overlapMinutes: number;
}) {
  return (
    <div className="rounded-xl border border-bad-500/30 bg-bad-50 text-bad-700 px-4 py-3 flex items-start gap-3">
      <span className="text-lg leading-none">⚠</span>
      <div>
        <p className="font-medium">Assignment Conflict — {employeeName}</p>
        <p className="text-sm">
          Extended AT201 Boarding duty overlaps with pre-planned {task}. {overlapMinutes}-minute overlap detected.
        </p>
      </div>
    </div>
  );
}
