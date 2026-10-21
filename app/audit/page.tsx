"use client";

import { useEffect, useState } from "react";
import { AuditLogEntry } from "@/lib/types";
import { Card } from "@/components/ui";
import { AuditTimeline } from "@/components/audit-timeline";
import { AUDIT_TAGS, AuditTagLabel, auditTag } from "@/lib/audit-format";

export default function AuditPage() {
  const [entries, setEntries] = useState<AuditLogEntry[] | null>(null);
  const [filter, setFilter] = useState<AuditTagLabel | "All">("All");

  useEffect(() => {
    fetch("/api/audit-log")
      .then((r) => r.json())
      .then((data) => setEntries(data.entries ?? []));
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[28px] leading-tight font-bold tracking-tight text-ink">Audit trail</h1>
        <p className="text-[15px] text-muted mt-1.5">
          Every recommendation, human decision, and operational event, in order — nothing here was
          executed automatically.
        </p>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter events">
        {(["All", ...AUDIT_TAGS] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setFilter(t)}
            aria-pressed={filter === t}
            className={`min-h-[44px] px-4 rounded-lg text-sm font-medium border ${
              filter === t ? "bg-brand-100 text-brand-700 border-brand-200" : "bg-white text-ink border-border hover:bg-gray-50"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <Card>
        {entries === null && <p className="text-sm text-muted">Loading…</p>}
        {entries?.length === 0 && (
          <p className="text-sm text-muted">No audit entries yet — reset the demo to seed the initial plan.</p>
        )}
        {entries && entries.length > 0 && (
          <AuditTimeline entries={entries.filter((e) => filter === "All" || auditTag(e.description).label === filter)} />
        )}
      </Card>
    </div>
  );
}
