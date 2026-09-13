"use client";

import { useState } from "react";
import { Button } from "./ui";

interface PlanSummary {
  managedFlights: number;
  dutiesAssigned: number;
  staffingGaps: number;
  hardRestViolations: number;
}

/**
 * The single user-facing trigger for the planning pipeline (flight
 * schedule -> requirements -> demand aggregation -> shift capacity ->
 * roster -> duties -> hard rest validation -> persisted Draft Weekly
 * Plan) -- see makePlanning's doc comment in
 * lib/planning/weekly-plan-service.ts for the exact state machine this
 * calls into. A normal page load/refresh never runs this: reading the
 * Weekly Planning page only ever shows whatever was last persisted, so
 * after changing the flight schedule a planner must explicitly click
 * this button to get a new plan from the updated program.
 *
 * The server decides what actually happens (create / clean regenerate /
 * blocked-by-manual-modifications / blocked-because-published) -- this
 * component only shows the outcome. A block is never silently retried or
 * hidden: it's surfaced as an explanation, exactly as returned. A success
 * shows the same counts the server actually persisted (managedFlights/
 * dutiesAssigned/staffingGaps/hardRestViolations -- see PlanSummary in
 * weekly-plan-service.ts), never a client-side recomputation.
 */
export function MakePlanningButton({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "blocked">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [summary, setSummary] = useState<PlanSummary | null>(null);

  async function handleClick() {
    setState("loading");
    setMessage(null);
    setSummary(null);
    try {
      const res = await fetch("/api/planning/make-planning", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setState("blocked");
        setMessage(data.error ?? "Make Planning was blocked for an unknown reason.");
        return;
      }
      setState("done");
      setSummary(data.summary ?? null);
      onDone();
    } catch {
      setState("blocked");
      setMessage("Make Planning failed -- could not reach the server.");
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button onClick={handleClick} disabled={state === "loading"}>
        {state === "loading" ? "Generating planning…" : "Make Planning"}
      </Button>
      {state === "done" && summary && (
        <p className="text-xs text-muted max-w-sm text-right">
          Planning generated — {summary.managedFlights} managed flights · {summary.dutiesAssigned} duties assigned ·{" "}
          {summary.staffingGaps} staffing gaps · {summary.hardRestViolations} hard violations
        </p>
      )}
      {message && <p className="text-xs text-bad-700 max-w-sm text-right">{message}</p>}
    </div>
  );
}
