"use client";

import { useEffect, useState } from "react";
import { CandidateResult } from "@/lib/types";
import { CandidateRow } from "./candidate-row";
import { Button } from "./ui";

export function FindAgentSheet({
  requirementId,
  onClose,
  onAssigned,
}: {
  requirementId: string;
  onClose: () => void;
  onAssigned: () => void;
}) {
  const [candidates, setCandidates] = useState<CandidateResult[] | null>(null);
  const [assigningId, setAssigningId] = useState<string | null>(null);

  function loadCandidates() {
    fetch(`/api/candidates/${requirementId}`)
      .then((r) => r.json())
      .then((data) => setCandidates(data.candidates ?? []));
  }

  useEffect(loadCandidates, [requirementId]);

  async function handleAssign(employeeId: string) {
    setAssigningId(employeeId);
    try {
      await fetch("/api/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ staffingRequirementId: requirementId, employeeId }),
      });
      onAssigned();
      loadCandidates();
    } finally {
      setAssigningId(null);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-full sm:max-w-md h-full bg-surface shadow-softer border-l border-border overflow-y-auto p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-ink">Find Agent</h2>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>

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
