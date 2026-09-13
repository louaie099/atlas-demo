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
 *
 * `onDone` MUST be the page's refetch of /api/planning/weekly-view (see
 * app/planning/page.tsx's loadWeeklyPlan) and MUST return the promise
 * that resolves once every dependent view's state (flights/roster/
 * schedule/issues/plan) has actually been set from the new response --
 * this component stays in the "loading" state (button disabled, showing
 * "Generating planning...") through that entire await, not just through
 * the POST itself. This is deliberate: persisting a new Draft revision
 * and the UI actually displaying it are two different things, and a
 * planner must never see "Planning generated" while Agent Schedule /
 * Flight Coverage / the summary bar are still showing the PREVIOUS
 * revision underneath. Whatever tab the planner is currently on stays
 * selected -- this component never switches tabs; the tab's own content
 * simply re-renders once the page's shared state updates, since it's the
 * exact same state every tab already reads from.
 */
export function MakePlanningButton({ onDone }: { onDone: () => Promise<void> }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "blocked">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [summary, setSummary] = useState<PlanSummary | null>(null);

  async function handleClick() {
    setState("loading");
    setMessage(null);
    setSummary(null);
    let data: { summary?: PlanSummary; error?: string };
    try {
      const res = await fetch("/api/planning/make-planning", { method: "POST" });
      data = await res.json();
      if (!res.ok) {
        setState("blocked");
        setMessage(data.error ?? "Make Planning was blocked for an unknown reason.");
        return;
      }
    } catch {
      setState("blocked");
      setMessage("Make Planning failed -- could not reach the server.");
      return;
    }

    // Generation succeeded and is persisted at this point -- but the
    // summary/success state below must not appear until the page has
    // actually refetched and rendered it (see the doc comment above).
    try {
      await onDone();
      setState("done");
      setSummary(data.summary ?? null);
    } catch {
      // The new plan IS safely persisted -- only reloading the page's own
      // view of it failed (e.g. a dropped connection). Never claim
      // success here: the visible tables could still be showing the old
      // revision.
      setState("blocked");
      setMessage("Planning was generated and saved, but the page could not reload it -- refresh to see the new plan.");
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
