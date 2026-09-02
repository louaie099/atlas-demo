import { AuditLogEntry } from "@/lib/types";

export function AuditTimeline({ entries }: { entries: AuditLogEntry[] }) {
  return (
    <ol className="relative border-l border-border ml-3">
      {entries.map((entry) => (
        <li key={entry.id} className="mb-6 ml-6">
          <span className="absolute -left-[7px] flex items-center justify-center w-3.5 h-3.5 rounded-full bg-brand-500 ring-4 ring-surface" />
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-brand-700 bg-brand-50 px-2 py-0.5 rounded-full">
              Step {entry.step_number}
            </span>
            <time className="text-xs text-muted">
              {new Date(entry.timestamp).toLocaleString()}
            </time>
          </div>
          <p className="text-sm text-ink mt-1">{entry.description}</p>
        </li>
      ))}
    </ol>
  );
}
