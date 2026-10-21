import { AuditLogEntry } from "@/lib/types";
import { auditTag, tidyAuditText } from "@/lib/audit-format";
import { Badge } from "./ui";
import { LinkedText } from "./entity-panel";

export function AuditTimeline({ entries }: { entries: AuditLogEntry[] }) {
  return (
    <ol className="relative border-l border-border ml-3">
      {entries.map((entry) => {
        const tag = auditTag(entry.description);
        return (
          <li key={entry.id} className="mb-6 ml-6">
            <span className="absolute -left-[7px] flex items-center justify-center w-3.5 h-3.5 rounded-full bg-brand-500 ring-4 ring-surface" />
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-xs font-semibold text-brand-700">Step {entry.step_number}</span>
              <Badge tone={tag.tone}>{tag.label}</Badge>
              <time className="text-xs text-muted">{new Date(entry.timestamp).toLocaleString()}</time>
            </div>
            <p className="text-sm text-ink mt-1.5">
              <LinkedText text={tidyAuditText(entry.description)} />
            </p>
          </li>
        );
      })}
    </ol>
  );
}
