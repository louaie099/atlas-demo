"use client";

import { useEffect, useState } from "react";
import { CandidateResult } from "@/lib/types";
import { CandidateRow } from "./candidate-row";
import { Button } from "./ui";

/**
 * The zone-gap variant of FindAgentSheet -- same UI/interaction shape,
 * against /api/checkin-zone-candidates/[id] and /api/checkin-zone-assign
 * instead of the flight-requirement routes. A zone-requirement gap fill is
 * conceptually the same "human modification against a draft plan" as
 * today's per-flight gap fill (see those routes' own doc comments), so
 * this deliberately mirrors FindAgentSheet closely rather than
 * introducing a different interaction pattern.
 */
export function ZoneFindAgentSheet({
  zoneRequirementId,
  onClose,
  onAssigned,
}: {
  zoneRequirementId: string;
  onClose: () => void;
  onAssigned: () => void;
}) {
  const [candidates, setCandidates] = useState<CandidateResult[] | null>(null);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function loadCandidates() {
    fetch(`/api/checkin-zone-candidates/${zoneRequirementId}`)
      .then((r) => r.json())
      .then((data) => setCandidates(data.candidates ?? []));
  }

  useEffect(loadCandidates, [zoneRequirementId]);

  async function handleAssign(employeeId: string) {
    setAssigningId(employeeId);
    setError(null);
    try {
      const res = await fetch("/api/checkin-zone-assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zoneRequirementId, employeeId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Assignment failed — please try again.");
        loadCandidates();
        return;
      }
      onAssigned();
      loadCandidates();
    } catch {
      setError("Could not reach the server — the assignment was not made. Please try again.");
    } finally {
      setAssigningId(null);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-full sm:max-w-md h-full bg-surface shadow-softer border-l border-border overflow-y-auto p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-ink">Find Agent — T1 Check-in Zone</h2>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>

        {error && (
          <p className="text-sm text-bad-700 bg-bad-50 border border-bad-500/30 rounded-lg px-3 py-2">{error}</p>
        )}

        {candidates === null && <p className="text-sm text-muted">Evaluating candidates…</p>}
        {candidates?.length === 0 && <p className="text-sm text-muted">No qualified candidates found.</p>}

        <div className="flex flex-col gap-3">
          {candidates?.map((c) => (
            <CandidateRow
              key={c.employee.id}
              candidate={c}
              assigning={assigningId === c.employee.id}
              onAssign={() => handleAssign(c.employee.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
