"use client";

import { useEffect, useState } from "react";
import { Employee, Flight, ResolutionRecommendation } from "@/lib/types";
import { LiveFlightCard } from "@/components/live-flight-card";
import { AlertBanner } from "@/components/alert-banner";
import { ResolutionPanel } from "@/components/resolution-panel";

interface Conflict {
  employeeName: string;
  plannedDuty: { task: string };
  overlapMinutes: number;
}

export default function OperationsPage() {
  const [flight, setFlight] = useState<Flight | null>(null);
  const [assignedEmployees, setAssignedEmployees] = useState<Employee[]>([]);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [recommendation, setRecommendation] = useState<ResolutionRecommendation | null>(null);
  const [simulating, setSimulating] = useState(false);

  function loadLiveOps() {
    fetch("/api/live-ops")
      .then((r) => r.json())
      .then((data) => {
        setFlight(data.flight);
        setAssignedEmployees(data.assignedEmployees ?? []);
      });
  }

  // TODO(UI agent): rewired to new routes — GET /api/live-ops now returns
  // real flights/requirements for a date (see lib/live-ops-service.ts's
  // LiveOpsView), and POST /api/live-ops/evaluate-impact + POST
  // /api/confirm-reassignment replace the old plannedDuty-based
  // recommendation/confirm flow. This page's old at201-shaped state
  // (flight/assignedEmployees/conflict/recommendation) and the
  // simulate-delay button below are stubbed out, not rebuilt, here.
  function loadRecommendation() {
    setRecommendation(null);
  }

  useEffect(() => {
    loadLiveOps();
  }, []);

  async function handleSimulateDelay() {
    setSimulating(true);
    try {
      // TODO(UI agent): call PATCH /api/flights/[id]/operational with a
      // real flightId + actual_departure, then POST
      // /api/live-ops/evaluate-impact to get the new conflicts/candidates.
    } finally {
      setSimulating(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Live Operations</h1>
        <p className="text-muted mt-1">
          Same flight, same assignments as Weekly Planning — this is the operational-day view of
          decisions already made.
        </p>
      </div>

      {conflict && (
        <AlertBanner
          employeeName={conflict.employeeName}
          task={conflict.plannedDuty.task}
          overlapMinutes={conflict.overlapMinutes}
        />
      )}

      {recommendation && (
        <ResolutionPanel
          recommendation={recommendation}
          onConfirmed={() => {
            setConflict(null);
            setRecommendation(null);
            loadLiveOps();
          }}
        />
      )}

      {flight && (
        <LiveFlightCard
          flight={flight}
          assignedEmployees={assignedEmployees}
          onSimulateDelay={handleSimulateDelay}
          simulating={simulating}
        />
      )}
    </div>
  );
}
