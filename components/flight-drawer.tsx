"use client";

import { useEffect, useState } from "react";
import { FlightStatus } from "@/lib/types";
import { LiveOpsFlightView, LiveOpsImpact, LiveOpsRequirementView } from "@/lib/live-ops-service";
import { FlightPhase, FLIGHT_PHASE_LABEL, resolveFlightPhase } from "@/lib/flight-phase";
import { canManageOperations } from "@/lib/roles";
import { useRole } from "./role-context";
import { ConflictCard } from "./edit-flight-drawer";
import { EmployeeChip, LiveOpsAssignRequest } from "./flight-ops-row";
import { Badge, Button } from "./ui";

const STATUS_OPTIONS: FlightStatus[] = ["scheduled", "delayed"];
const PHASE_OPTIONS = Object.keys(FLIGHT_PHASE_LABEL) as FlightPhase[];

/**
 * Flight Operational Drawer (redesign sections 5–6) — supersedes the old
 * EditFlightDrawer as the ONE thing a flight click opens. Two modes:
 *
 *  - "view" (the default): flight info, an "Edit flight" action, and the
 *    STAFFING drill-down (valid-assigned/required per requirement, the
 *    Planned/Current/Shift/Reason explanation for any invalid assignment,
 *    Find replacement for a gap). Opening in this mode PROACTIVELY calls
 *    evaluate-impact so a flight already in gap/conflict state shows its
 *    real explanation immediately — not only right after an edit in THIS
 *    session (what EditFlightDrawer only ever did). This is what makes
 *    "click a notification → drawer opens → click Gate gap → inspect
 *    affected assignments" work correctly even for a flight edited
 *    earlier, in an entirely separate drawer session.
 *  - "edit": the existing operational edit form (unchanged fields/flow) —
 *    saving still PATCHes the flight then evaluates impact, exactly as
 *    EditFlightDrawer did; the only difference is the result renders back
 *    into this same drawer's STAFFING section instead of a separate
 *    conflict-only screen, and a real new conflict is also reported
 *    upward via `onNotify` for the toast/attention-center.
 */
export function FlightDrawer({
  view,
  onClose,
  onSaved,
  onConflictStateChange,
  onNotify,
  onRequestAssign,
  focusRequirementId,
}: {
  view: LiveOpsFlightView;
  onClose: () => void;
  onSaved: () => void;
  onConflictStateChange: (flightId: string, active: boolean) => void;
  onNotify: (impact: LiveOpsImpact) => void;
  onRequestAssign: (request: LiveOpsAssignRequest) => void;
  /** A notification click's target requirement — scrolled to and briefly highlighted on open. */
  focusRequirementId?: string;
}) {
  const { role } = useRole();
  const canAct = canManageOperations(role);
  const { flight, effectiveDeparture } = view;

  const [mode, setMode] = useState<"view" | "edit">("view");
  const [currentDeparture, setCurrentDeparture] = useState(effectiveDeparture);
  const [gate, setGate] = useState(flight.gate ?? "");
  const [status, setStatus] = useState<FlightStatus>(flight.status);
  const [phaseOverride, setPhaseOverride] = useState<FlightPhase | "">(flight.operational_phase_override ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [impact, setImpact] = useState<LiveOpsImpact | null>(null);
  const [loadingImpact, setLoadingImpact] = useState(false);
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set());

  // Proactive evaluate-impact on open (see this component's own doc
  // comment) — read-only, safe to call even when nothing is actually
  // wrong; an empty conflicts array just means nothing to drill into.
  useEffect(() => {
    setLoadingImpact(true);
    fetch("/api/live-ops/evaluate-impact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flightId: flight.id }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data && Array.isArray(data.conflicts)) {
          setImpact(data as LiveOpsImpact);
          onConflictStateChange(flight.id, data.conflicts.length > 0);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingImpact(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flight.id]);

  useEffect(() => {
    if (!focusRequirementId) return;
    const el = document.getElementById(`live-ops-requirement-${focusRequirementId}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusRequirementId, impact]);

  function close() {
    onClose();
  }

  function conflictsForRequirement(requirementId: string) {
    return (impact?.conflicts ?? []).filter((c) => c.requirement.id === requirementId && !resolvedIds.has(`${requirementId}:${c.employee.id}`));
  }

  function handleConflictConfirmed(requirementId: string, employeeId: string) {
    const next = new Set(resolvedIds);
    next.add(`${requirementId}:${employeeId}`);
    setResolvedIds(next);
    const stillOpen = (impact?.conflicts ?? []).filter(
      (c) => !(next.has(`${c.requirement.id}:${c.employee.id}`))
    );
    onConflictStateChange(flight.id, stillOpen.length > 0);
    onSaved();
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
        setMode("view");
        return;
      }

      setImpact(impactData as LiveOpsImpact);
      setResolvedIds(new Set());
      onConflictStateChange(flight.id, impactData.conflicts.length > 0);
      if (impactData.conflicts.length > 0) onNotify(impactData as LiveOpsImpact);
      onSaved();
      setMode("view");
    } catch {
      setError("Could not reach the server — nothing was saved.");
    } finally {
      setSaving(false);
    }
  }

  const resolved = resolveFlightPhase(flight, effectiveDeparture, 0);

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={close} />
      <div className="relative w-full sm:max-w-lg h-full bg-surface shadow-softer border-l border-border overflow-y-auto p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-ink">
            {flight.flight_number} · {flight.destination ?? flight.route}
          </h2>
          <Button variant="ghost" onClick={close}>
            Close
          </Button>
        </div>

        {error && (
          <p className="text-sm text-bad-700 bg-bad-50 border border-bad-500/30 rounded-lg px-3 py-2">{error}</p>
        )}

        {mode === "view" && (
          <>
            {/* ---- Flight information ---- */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm bg-card border border-border rounded-xl2 p-4">
              <div>
                <p className="text-xs text-muted">Scheduled departure</p>
                <p className="text-ink font-medium">{flight.scheduled_departure}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Current departure</p>
                <p className="text-ink font-medium">{effectiveDeparture}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Destination</p>
                <p className="text-ink font-medium">{flight.destination ?? flight.route}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Aircraft</p>
                <p className="text-ink font-medium">{flight.aircraft}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Gate</p>
                <p className="text-ink font-medium">{flight.gate ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Operational status</p>
                <p className="text-ink font-medium">{FLIGHT_PHASE_LABEL[resolved.phase]}</p>
              </div>
            </div>

            <Button variant="secondary" onClick={() => setMode("edit")} disabled={!canAct} className="self-start">
              Edit flight
            </Button>

            {/* ---- Staffing ---- */}
            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold text-ink">Staffing</h3>
              {loadingImpact && <p className="text-xs text-muted">Checking assignment validity…</p>}
              {view.requirements.length === 0 && <p className="text-sm text-muted">No staffing requirements for this flight.</p>}

              {view.requirements.map((r) => (
                <RequirementSection
                  key={r.requirement.id}
                  requirement={r}
                  flight={impact?.flight ?? flight}
                  conflicts={conflictsForRequirement(r.requirement.id)}
                  canAct={canAct}
                  onRequestAssign={onRequestAssign}
                  onConflictConfirmed={(employeeId) => handleConflictConfirmed(r.requirement.id, employeeId)}
                />
              ))}
            </div>
          </>
        )}

        {mode === "edit" && (
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

            <div className="flex items-center gap-2">
              <Button onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
              <Button variant="ghost" onClick={() => setMode("view")} disabled={saving}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** One STAFFING requirement row — valid-assigned/required, drilling down
 * into either the conflict explanation (an employee currently invalid for
 * this window), a plain unfilled gap, or a covered/reassignable chip
 * list, per section 5–6 of the redesign spec. */
function RequirementSection({
  requirement,
  flight,
  conflicts,
  canAct,
  onRequestAssign,
  onConflictConfirmed,
}: {
  requirement: LiveOpsRequirementView;
  flight: LiveOpsImpact["flight"];
  conflicts: import("@/lib/live-ops-service").LiveOpsImpactConflict[];
  canAct: boolean;
  onRequestAssign: (request: LiveOpsAssignRequest) => void;
  onConflictConfirmed: (employeeId: string) => void;
}) {
  const invalidEmployeeIds = new Set(conflicts.map((c) => c.employee.id));
  const validAssigned = requirement.assignedEmployees.filter((e) => !invalidEmployeeIds.has(e.id));
  const validProposed = requirement.proposedEmployees.filter((e) => !invalidEmployeeIds.has(e.id));
  const validCount = validAssigned.length + validProposed.length;
  const required = requirement.requirement.total_requirement;
  const hasProblem = validCount < required || conflicts.length > 0;

  return (
    <div
      id={`live-ops-requirement-${requirement.requirement.id}`}
      className={`rounded-xl border px-4 py-3 flex flex-col gap-2 ${hasProblem ? "border-bad-500/30 bg-bad-50/30" : "border-border bg-card"}`}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-ink">{requirement.coverageLabel}</span>
        <Badge tone={hasProblem ? "bad" : "good"}>
          {validCount}/{required}
        </Badge>
      </div>

      {requirement.modification && (
        <p className="text-xs text-muted">
          Planned: {requirement.modification.previousEmployeeName} · Operational: {requirement.modification.newEmployeeName}
        </p>
      )}

      {conflicts.map((c) => (
        <ConflictCard key={c.employee.id} conflict={c} flight={flight} onConfirmed={() => onConflictConfirmed(c.employee.id)} />
      ))}

      {conflicts.length === 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          {[...validAssigned, ...validProposed].length === 0 ? (
            <span className="text-xs text-muted">— gap —</span>
          ) : (
            [...validAssigned, ...validProposed].map((e) => (
              <EmployeeChip
                key={e.id}
                name={e.name}
                tone={validAssigned.some((a) => a.id === e.id) ? "assigned" : "proposed"}
                canAct={canAct}
                onReassign={() =>
                  onRequestAssign({
                    mode: "reassign",
                    requirementId: requirement.requirement.id,
                    roleLabel: requirement.coverageLabel,
                    employeeId: e.id,
                    employeeName: e.name,
                  })
                }
              />
            ))
          )}
          {validCount < required && (
            <Button
              variant="secondary"
              disabled={!canAct}
              className="!px-2 !py-1 !text-xs !shadow-none"
              onClick={() =>
                onRequestAssign({ mode: "assign", requirementId: requirement.requirement.id, roleLabel: requirement.coverageLabel })
              }
            >
              Find replacement
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
