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

  function loadRecommendation() {
    fetch("/api/confirm-reassignment")
      .then((r) => r.json())
      .then((data) => setRecommendation(data.recommendation ?? null));
  }

  useEffect(() => {
    loadLiveOps();
    loadRecommendation();
  }, []);

  async function handleSimulateDelay() {
    setSimulating(true);
    try {
      const res = await fetch("/api/simulate-delay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delayMinutes: 45 }),
      });
      const data = await res.json();
      setFlight(data.flight);
      setConflict(data.conflict);
      if (data.conflict) loadRecommendation();
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
