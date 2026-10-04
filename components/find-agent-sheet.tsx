"use client";

import { useEffect, useState } from "react";
import { CandidateResult } from "@/lib/types";
import { ROLE_HEADER, canManageOperations } from "@/lib/roles";
import { useRole } from "./role-context";
import { CandidateRow } from "./candidate-row";
import { Button } from "./ui";

/**
 * One sheet, two modes (2026-10-04 — previously Find Agent-only, i.e.
 * always "assign"). In "reassign" mode this fills an already-covered
 * requirement's slot: `replacingEmployeeId`/`replacingEmployeeName`
 * identify whose place is being taken, the sheet posts to
 * /api/confirm-reassignment instead of /api/assign, and the heading/empty
 * state read accordingly. The candidate list itself needs no special
 * handling for this: getCandidatesForRequirement
 * (lib/planning/candidate-lookup.ts) already excludes every employee
 * currently holding this requirement — including whoever is being
 * replaced — from its own candidate pool, so GET
 * /api/candidates/[requirementId] is reused unchanged for both modes; the
 * same recommended/flagged + reasoning (shift, qualification, rest/
 * availability) and exclusion-summary breakdown Find Agent already shows
 * is what the reassignment flow shows too, never a separate selection
 * path.
 */
export function FindAgentSheet({
  requirementId,
  mode = "assign",
  replacingEmployeeId,
  replacingEmployeeName,
  roleLabel,
  onClose,
  onAssigned,
}: {
  requirementId: string;
  mode?: "assign" | "reassign";
  replacingEmployeeId?: string;
  replacingEmployeeName?: string;
  /** Requirement role/label shown in the reassign heading (e.g. "Gate"). */
  roleLabel?: string;
  onClose: () => void;
  onAssigned: () => void;
}) {
  const { role } = useRole();
  const allowed = canManageOperations(role);
  const [candidates, setCandidates] = useState<CandidateResult[] | null>(null);
  const [exclusionSummary, setExclusionSummary] = useState<{ reason: string; count: number }[]>([]);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function loadCandidates() {
    fetch(`/api/candidates/${requirementId}`)
      .then((r) => r.json())
      .then((data) => {
        setCandidates(data.candidates ?? []);
        setExclusionSummary(data.exclusionSummary ?? []);
      });
  }

  useEffect(loadCandidates, [requirementId]);

  /**
   * The Assign/Reassign click is only "done" once the server has
   * confirmed the change was actually persisted — a failed request
   * (already full, no-longer-eligible, overlapping duty, stale incumbent,
   * or a server error) must surface a concrete reason and leave coverage
   * untouched, never silently do nothing and never optimistically update
   * local state as if it had succeeded.
   */
  async function handleAssign(employeeId: string) {
    setAssigningId(employeeId);
    setError(null);
    try {
      const res =
        mode === "reassign" && replacingEmployeeId
          ? await fetch("/api/confirm-reassignment", {
              method: "POST",
              headers: { "Content-Type": "application/json", [ROLE_HEADER]: role },
              body: JSON.stringify({
                staffingRequirementId: requirementId,
                oldEmployeeId: replacingEmployeeId,
                newEmployeeId: employeeId,
                reason: "Manual operational reassignment from Live Operations.",
              }),
            })
          : await fetch("/api/assign", {
              method: "POST",
              headers: { "Content-Type": "application/json", [ROLE_HEADER]: role },
              body: JSON.stringify({ staffingRequirementId: requirementId, employeeId }),
            });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "That change failed — please try again.");
        loadCandidates(); // the candidate list may itself be stale (e.g. requirement just filled/changed)
        return;
      }
      onAssigned();
      loadCandidates();
    } catch {
      setError("Could not reach the server — nothing was changed. Please try again.");
    } finally {
      setAssigningId(null);
    }
  }

  const heading =
    mode === "reassign"
      ? `Reassign${roleLabel ? ` — ${roleLabel}` : ""}`
      : "Find Agent";

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-full sm:max-w-md h-full bg-surface shadow-softer border-l border-border overflow-y-auto p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-ink">{heading}</h2>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>

        {mode === "reassign" && replacingEmployeeName && (
          <p className="text-sm text-muted">Replacing {replacingEmployeeName}.</p>
        )}

        {!allowed && (
          <p className="text-sm text-warn-700 bg-warn-50 border border-warn-500/30 rounded-lg px-3 py-2">
            Viewing only — switch to Planner or Administrator to {mode === "reassign" ? "reassign" : "assign"} agents.
          </p>
        )}

        {error && (
          <p className="text-sm text-bad-700 bg-bad-50 border border-bad-500/30 rounded-lg px-3 py-2">{error}</p>
        )}

        {candidates === null && <p className="text-sm text-muted">Evaluating candidates…</p>}
        {candidates?.length === 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted">
              No qualified candidates found{exclusionSummary.length > 0 ? " — here is why every employee was excluded:" : "."}
            </p>
            {exclusionSummary.length > 0 && (
              <ul className="text-xs text-muted bg-surface border border-border rounded-lg px-3 py-2 flex flex-col gap-1">
                {exclusionSummary.map((e) => (
                  <li key={e.reason} className="flex items-center justify-between gap-3">
                    <span>{e.reason}</span>
                    <span className="font-medium text-ink">{e.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex flex-col gap-3">
          {candidates?.map((c) => (
            <CandidateRow
              key={c.employee.id}
              candidate={c}
              assigning={assigningId === c.employee.id}
              disabled={!allowed}
              actionLabel={mode === "reassign" ? "Reassign" : undefined}
              onAssign={() => handleAssign(c.employee.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
