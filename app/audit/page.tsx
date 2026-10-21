"use client";

import { useEffect, useState } from "react";
import { AuditLogEntry } from "@/lib/types";
import { Card } from "@/components/ui";
import { AuditTimeline } from "@/components/audit-timeline";

export default function AuditPage() {
  const [entries, setEntries] = useState<AuditLogEntry[] | null>(null);

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

      <Card>
        {entries === null && <p className="text-sm text-muted">Loading…</p>}
        {entries?.length === 0 && (
          <p className="text-sm text-muted">No audit entries yet — reset the demo to seed the initial plan.</p>
        )}
        {entries && entries.length > 0 && <AuditTimeline entries={entries} />}
      </Card>
    </div>
  );
}
