"use client";

import { useState } from "react";
import { CandidateResult } from "@/lib/types";
import { Badge, Button } from "./ui";

const FATIGUE_LABEL: Record<NonNullable<CandidateResult["fatigueLevel"]>, string> = {
  unknown: "Fatigue: unknown",
  low: "Low fatigue",
  moderate: "Moderate fatigue",
  high: "High fatigue",
};

const FATIGUE_TONE: Record<NonNullable<CandidateResult["fatigueLevel"]>, "good" | "warn" | "bad" | "neutral"> = {
  unknown: "neutral",
  low: "good",
  moderate: "warn",
  high: "bad",
};

export function CandidateRow({
  candidate,
  onAssign,
  assigning,
  disabled = false,
  actionLabel,
}: {
  candidate: CandidateResult;
  onAssign: () => void;
  assigning: boolean;
  /** True when the current role may not act (e.g. Viewer) — the button
   * stays visible (so the candidate ranking is still informative) but
   * can't be clicked. */
  disabled?: boolean;
  /** Overrides the default "Assign"/"Assign with override" wording — used
   * by the Live Operations reassignment flow (find-agent-sheet.tsx) so
   * the button reads "Reassign" instead. */
  actionLabel?: string;
}) {
  const [showFatigueDetail, setShowFatigueDetail] = useState(false);
  const recommended = candidate.status === "recommended";
  const hasFatigueSignal = candidate.fatigueLevel !== undefined;

  return (
    <div
      className={`rounded-xl border p-4 flex flex-col gap-2 ${
        recommended ? "border-good-500/40 bg-good-50/40" : "border-border bg-white"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-ink">{candidate.employee.name}</span>
        <Badge tone={recommended ? "good" : "warn"}>
          {recommended ? "Recommended" : "Flagged"}
        </Badge>
      </div>
      <p className="text-sm text-muted">{candidate.reasoning}</p>

      {(hasFatigueSignal || candidate.tasksToday !== undefined) && (
        <div className="flex items-center gap-2 flex-wrap text-xs">
          {hasFatigueSignal && (
            <button
              type="button"
              onClick={() => setShowFatigueDetail((v) => !v)}
              className="inline-flex"
              title="Click to see why"
            >
              <Badge tone={FATIGUE_TONE[candidate.fatigueLevel!]}>
                {FATIGUE_LABEL[candidate.fatigueLevel!]}
                {candidate.fatigueLevel !== "unknown" ? " · details" : ""}
              </Badge>
            </button>
          )}
          {candidate.tasksToday !== undefined && (
            <span className="text-muted">
              {candidate.tasksToday} dut{candidate.tasksToday === 1 ? "y" : "ies"} today
            </span>
          )}
        </div>
      )}

      {showFatigueDetail && candidate.fatigueLevel === "high" && (
        <p className="text-xs text-bad-700 bg-bad-50 border border-bad-500/30 rounded-lg px-3 py-2">
          ⚠ Higher fatigue burden
        </p>
      )}
      {showFatigueDetail && candidate.fatigueLevelReasons && candidate.fatigueLevelReasons.length > 0 && (
        <ul className="text-xs text-muted bg-surface border border-border rounded-lg px-3 py-2 flex flex-col gap-1">
          {candidate.fatigueLevelReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      {showFatigueDetail && candidate.fatigueReason && candidate.fatigueReason.length > 0 && (
        <ul className="text-xs text-muted bg-surface border border-border rounded-lg px-3 py-2 flex flex-col gap-1">
          {candidate.fatigueReason.map((reason) => (
            <li key={`vs-next-${reason}`}>vs. next candidate: {reason}</li>
          ))}
        </ul>
      )}

      <Button
        variant={recommended ? "primary" : "secondary"}
        onClick={onAssign}
        disabled={assigning || disabled}
        className="self-start"
      >
        {assigning
          ? `${actionLabel ?? "Assign"}ing…`
          : actionLabel
          ? recommended
            ? actionLabel
            : `${actionLabel} with override`
          : recommended
          ? "Assign"
          : "Assign with override"}
      </Button>
    </div>
  );
}
