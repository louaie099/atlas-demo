"use client";

import { useState } from "react";
import { CandidateResult, Flight, FlightStatus } from "@/lib/types";
import { LiveOpsImpact, LiveOpsImpactConflict } from "@/lib/live-ops-service";
import { FlightPhase, FLIGHT_PHASE_LABEL } from "@/lib/flight-phase";
import { ROLE_HEADER, canManageOperations } from "@/lib/roles";
import { useRole } from "./role-context";
import { Badge, Button } from "./ui";

const STATUS_OPTIONS: FlightStatus[] = ["scheduled", "delayed"];
const PHASE_OPTIONS = Object.keys(FLIGHT_PHASE_LABEL) as FlightPhase[];

/**
 * One detected conflict from evaluate-impact, with ATLAS's top
 * recommendation inline and a way to pick a different eligible candidate
 * instead -- reuses Find Agent's own CandidateResult shape/visual
 * convention (recommended vs flagged, reasoning text), never a new one.
 * An honest "no eligible replacement" state when replacementCandidates is
 * empty -- never a forced or implied assignment.
 */
function ConflictCard({
  conflict,
  flight,
  onConfirmed,
}: {
  conflict: LiveOpsImpactConflict;
  flight: Flight;
  onConfirmed: () => void;
}) {
  const { role } = useRole();
  const allowed = canManageOperations(role);
  const top = conflict.replacementCandidates[0] as CandidateResult | undefined;
  const [selectedId, setSelectedId] = useState<string>(top?.employee.id ?? "");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<string | null>(null);

  const selected = conflict.replacementCandidates.find((c) => c.employee.id === selectedId);

  async function handleConfirm() {
    if (!selected) return;
    setConfirming(true);
    setError(null);
    try {
      const res = await fetch("/api/confirm-reassignment", {
        method: "POST",
        headers: { "Content-Type": "application/json", [ROLE_HEADER]: role },
        body: JSON.stringify({
          staffingRequirementId: conflict.requirement.id,
          oldEmployeeId: conflict.employee.id,
          newEmployeeId: selected.employee.id,
          reason: `Operational departure change on ${flight.flight_number} created a scheduling conflict for ${conflict.employee.name}.`,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Reassignment failed — please try again.");
        return;
      }
      setConfirmed(selected.employee.name);
      onConfirmed();
    } catch {
      setError("Could not reach the server — the reassignment was not made.");
    } finally {
      setConfirming(false);
    }
  }

  if (confirmed) {
    return (
      <div className="rounded-xl border border-good-500/40 bg-good-50/50 px-4 py-3 text-sm text-good-700">
        Reassigned — {flight.flight_number} {conflict.requirement.role} now covered by {confirmed}.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-bad-500/30 bg-bad-50/40 px-4 py-3 flex flex-col gap-3">
      <div className="text-sm">
        <p className="font-medium text-ink">
          Conflict detected — {flight.flight_number} {conflict.requirement.role} requires reassignment
        </p>
        <div className="text-muted mt-1 flex flex-col gap-1">
          {/* Either or both reasons can apply at once -- each gets its own
              line so a shift-end violation never has to be awkwardly
              squeezed into collision wording, or vice versa. */}
          {conflict.shiftBoundaryViolation && (
            <p>
              {conflict.employee.name} unavailable — shift ends at {conflict.shiftBoundaryViolation.shiftEnd} (shift{" "}
              {conflict.shiftBoundaryViolation.shiftStart}–{conflict.shiftBoundaryViolation.shiftEnd}).
            </p>
          )}
          {conflict.collidesWith && (
            <p>
              {conflict.employee.name} is also committed to {conflict.collidesWith.flight.flight_number}{" "}
              {conflict.collidesWith.requirement.role} ({conflict.collidesWith.window.start}–
              {conflict.collidesWith.window.end}).
            </p>
          )}
          <p>
            New window {conflict.newWindow.start}–{conflict.newWindow.end} (was {conflict.oldWindow.start}–
            {conflict.oldWindow.end}).
          </p>
        </div>
      </div>

      {error && <p className="text-sm text-bad-700">{error}</p>}

      {conflict.replacementCandidates.length === 0 ? (
        <p className="text-sm text-muted">
          No eligible replacement found — this is a real operational gap.
          {conflict.exclusionSummary && conflict.exclusionSummary.length > 0 && (
            <span className="block mt-1 text-xs">
              {conflict.exclusionSummary.map((e) => `${e.reason} (${e.count})`).join(" · ")}
            </span>
          )}
        </p>
      ) : (
        <>
          <p className="text-sm text-ink">
            Recommended: <span className="font-medium">{top?.employee.name}</span>
            {top?.reasoning ? ` — ${top.reasoning}` : ""}
          </p>

          {conflict.replacementCandidates.length > 1 && (
            <label className="text-xs text-muted flex flex-col gap-1">
              Or pick a different candidate
              <select
                className="border border-border rounded-lg px-2 py-1.5 text-sm text-ink"
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
              >
                {conflict.replacementCandidates.map((c) => (
                  <option key={c.employee.id} value={c.employee.id}>
                    {c.employee.name} {c.status === "recommended" ? "(recommended)" : "(flagged)"}
                  </option>
                ))}
              </select>
            </label>
          )}

          {!allowed && (
            <p className="text-xs text-warn-700">Viewing only — switch to Planner or Administrator to confirm.</p>
          )}

          <Button onClick={handleConfirm} disabled={confirming || !selected || !allowed} className="self-start">
            {confirming ? "Confirming…" : "Confirm reassignment"}
          </Button>
        </>
      )}
    </div>
  );
}

export function EditFlightDrawer({
  flight,
  effectiveDeparture,
  onClose,
  onSaved,
  onConflictStateChange,
}: {
  flight: Flight;
  effectiveDeparture: string;
  onClose: () => void;
  onSaved: () => void;
  // Lets the parent board reflect "this flight has an active, unresolved
  // conflict" in its per-flight state while this drawer is open -- cleared
  // when the drawer closes or every conflict is confirmed.
  onConflictStateChange: (flightId: string, active: boolean) => void;
}) {
  const [currentDeparture, setCurrentDeparture] = useState(effectiveDeparture);
  const [gate, setGate] = useState(flight.gate ?? "");
  const [status, setStatus] = useState<FlightStatus>(flight.status);
  const [phaseOverride, setPhaseOverride] = useState<FlightPhase | "">(flight.operational_phase_override ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [impact, setImpact] = useState<LiveOpsImpact | null>(null);
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set());

  const openConflicts = impact?.conflicts.filter((c) => !resolvedIds.has(c.requirement.id)) ?? [];

  function close() {
    onConflictStateChange(flight.id, false);
    onClose();
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const patchRes = await fetch(`/api/flights/${flight.id}/operational`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actual_departure: currentDeparture.trim() === "" ? null : currentDeparture,
          status,
          gate: gate.trim() === "" ? null : gate,
          operational_phase_override: phaseOverride === "" ? null : phaseOverride,
        }),
      });
      const patchData = await patchRes.json().catch(() => ({}));
      if (!patchRes.ok) {
        setError(patchData.error ?? "Could not save the flight update.");
        return;
      }

      const impactRes = await fetch("/api/live-ops/evaluate-impact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flightId: flight.id }),
      });
      const impactData = await impactRes.json().catch(() => ({}));
      if (!impactRes.ok) {
        setError(impactData.error ?? "Saved, but could not evaluate downstream impact.");
        onSaved();
        return;
      }

      setImpact(impactData as LiveOpsImpact);
      setResolvedIds(new Set());

      if (!impactData.conflicts || impactData.conflicts.length === 0) {
        onConflictStateChange(flight.id, false);
        onSaved();
        close();
      } else {
        onConflictStateChange(flight.id, true);
        onSaved(); // refresh board behind the drawer so the new departure/status show immediately
      }
    } catch {
      setError("Could not reach the server — nothing was saved.");
    } finally {
      setSaving(false);
    }
  }

  function handleConflictConfirmed(requirementId: string) {
    const next = new Set(resolvedIds);
    next.add(requirementId);
    setResolvedIds(next);
    if (impact && next.size >= impact.conflicts.length) {
      onConflictStateChange(flight.id, false);
    }
    onSaved();
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={close} />
      <div className="relative w-full sm:max-w-md h-full bg-surface shadow-softer border-l border-border overflow-y-auto p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-ink">Edit operational information</h2>
          <Button variant="ghost" onClick={close}>
            Close
          </Button>
        </div>

        <p className="text-sm text-muted">
          {flight.flight_number} · {flight.route}
        </p>

        {error && (
          <p className="text-sm text-bad-700 bg-bad-50 border border-bad-500/30 rounded-lg px-3 py-2">{error}</p>
        )}

        {!impact && (
          <div className="flex flex-col gap-3">
            <label className="text-sm text-ink flex flex-col gap-1">
              Scheduled departure: <span className="text-muted">{flight.scheduled_departure}</span>
            </label>

            <label className="text-sm text-ink flex flex-col gap-1">
              Current departure (leave empty to clear back to scheduled)
              <input
                type="time"
                className="border border-border rounded-lg px-3 py-2 text-sm"
                value={currentDeparture}
                onChange={(e) => setCurrentDeparture(e.target.value)}
              />
            </label>

            <label className="text-sm text-ink flex flex-col gap-1">
              Gate
              <input
                type="text"
                className="border border-border rounded-lg px-3 py-2 text-sm"
                value={gate}
                onChange={(e) => setGate(e.target.value)}
                placeholder="e.g. B12"
              />
            </label>

            <label className="text-sm text-ink flex flex-col gap-1">
              Operational status
              <select
                className="border border-border rounded-lg px-3 py-2 text-sm"
                value={status}
                onChange={(e) => setStatus(e.target.value as FlightStatus)}
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-sm text-ink flex flex-col gap-1">
              Flight phase
              <select
                className="border border-border rounded-lg px-3 py-2 text-sm"
                value={phaseOverride}
                onChange={(e) => setPhaseOverride(e.target.value as FlightPhase | "")}
              >
                <option value="">Auto (follow departure time)</option>
                {PHASE_OPTIONS.map((p) => (
                  <option key={p} value={p}>
                    {FLIGHT_PHASE_LABEL[p]}
                  </option>
                ))}
              </select>
            </label>

            <Button onClick={handleSave} disabled={saving} className="self-start">
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        )}

        {impact && (
          <div className="flex flex-col gap-3">
            {openConflicts.length === 0 ? (
              <div className="rounded-xl border border-good-500/40 bg-good-50/50 px-4 py-3 text-sm text-good-700">
                No remaining conflicts for this flight.
              </div>
            ) : (
              <>
                <Badge tone="bad">
                  {openConflicts.length} conflict{openConflicts.length > 1 ? "s" : ""} to resolve
                </Badge>
                {openConflicts.map((c) => (
                  <ConflictCard
                    key={c.requirement.id}
                    conflict={c}
                    flight={impact.flight}
                    onConfirmed={() => handleConflictConfirmed(c.requirement.id)}
                  />
                ))}
              </>
            )}
            <Button variant="secondary" onClick={close} className="self-start">
              Done
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
