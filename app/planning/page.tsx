"use client";

import { useEffect, useState } from "react";
import { RosterRequirementView } from "@/lib/types";
import { RosterCard } from "@/components/roster-card";
import { FindAgentSheet } from "@/components/find-agent-sheet";
import { AddFlightForm } from "@/components/add-flight-form";

export default function PlanningPage() {
  const [roster, setRoster] = useState<RosterRequirementView[] | null>(null);
  const [openRequirementId, setOpenRequirementId] = useState<string | null>(null);

  function loadRoster() {
    fetch("/api/roster")
      .then((r) => r.json())
      .then((data) => setRoster(data.roster ?? []));
  }

  useEffect(loadRoster, []);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Weekly Planning</h1>
        <p className="text-muted mt-1">
          Every requirement below is calculated before the operational day begins — some from fixed
          per-aircraft rules, some from Atlas's demand forecast.
        </p>
      </div>

      {roster === null && <p className="text-sm text-muted">Loading roster…</p>}

      <AddFlightForm onAdded={loadRoster} />

      <div className="grid sm:grid-cols-2 gap-4">
        {roster?.map((view) => (
          <RosterCard key={view.requirement.id} view={view} onFindAgent={setOpenRequirementId} />
        ))}
      </div>

      {openRequirementId && (
        <FindAgentSheet
          requirementId={openRequirementId}
          onClose={() => setOpenRequirementId(null)}
          onAssigned={() => {
            loadRoster();
          }}
        />
      )}
    </div>
  );
}
