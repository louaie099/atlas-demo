"use client";

import { useState } from "react";
import { ResolutionRecommendation } from "@/lib/types";
import { Button, Card } from "./ui";

export function ResolutionPanel({
  recommendation,
  onConfirmed,
}: {
  recommendation: ResolutionRecommendation;
  onConfirmed: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  async function handleConfirm() {
    setConfirming(true);
    try {
      await fetch("/api/confirm-reassignment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plannedDutyId: recommendation.plannedDuty.id,
          newEmployeeId: recommendation.recommendedEmployee.id,
        }),
      });
      onConfirmed();
    } finally {
      setConfirming(false);
    }
  }

  return (
    <Card className="border-brand-100 bg-brand-50/40 flex flex-col gap-3">
      <p className="font-medium text-ink">
        Recommended resolution: reassign to {recommendation.recommendedEmployee.name}
      </p>
      <p className="text-sm text-muted">{recommendation.reasoning}</p>
      <Button onClick={handleConfirm} disabled={confirming} className="self-start">
        {confirming ? "Confirming…" : "Confirm Reassignment"}
      </Button>
    </Card>
  );
}
