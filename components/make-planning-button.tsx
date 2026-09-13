"use client";

import { useState } from "react";
import { Button } from "./ui";

interface PlanSummary {
  managedFlights: number;
  dutiesAssigned: number;
  staffingGaps: number;
  warnings: number;
  blockingConflicts: number;
  hardRestViolations: number;
}

// The minimal shape this component needs from whatever `onDone` resolves
// with -- it never touches anything else on the fetched plan, so it
// doesn't need the full WeeklyPlan type from lib/types.
interface FetchedPlanIdentity {
  id: string;
  revision: number;
}

// How many times to re-run `onDone` (the page's own weekly-view refetch)
// looking for the exact revision Make Planning just persisted, and how
// long to wait between attempts. A single refetch resolving is NOT proof
// it returned the new revision -- an intermediate cache or a lagging read
// replica can resolve with a perfectly valid, merely STALE response (see
// this component's doc comment) -- so this retries a genuinely fresh
// no-store fetch a few times before giving up and surfacing that
// honestly, rather than either (a) trusting the first response blindly or
// (b) hanging forever.
const REVISION_POLL_ATTEMPTS = 5;
const REVISION_POLL_DELAY_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * dutiesAssigned/staffingGaps/warnings/blockingConflicts/
 * hardRestViolations -- see PlanSummary in weekly-plan-service.ts), never
 * a client-side recomputation. When blockingConflicts > 0 the wording
 * itself changes to "Planning generated with conflicts" -- a plan with
 * unresolved BLOCKING configuration conflicts is real and persisted, but
 * NOT operationally healthy, and the summary must never imply otherwise
 * just because hardRestViolations itself reads 0 (that count only proves
 * nothing illegal was persisted, not that the plan is complete).
 *
 * `onDone` MUST be the page's refetch of /api/planning/weekly-view (see
 * app/planning/page.tsx's loadWeeklyPlan) and MUST return a promise that
 * resolves, once every dependent view's state (flights/roster/schedule/
 * issues/plan) has actually been set from the new response, with the
 * fetched plan itself (or null) -- this component stays in the "loading"
 * state (button disabled, showing "Generating planning...") through that
 * entire await, not just through the POST itself. This is deliberate:
 * persisting a new Draft revision and the UI actually displaying it are
 * two different things, and a planner must never see "Planning generated"
 * while Agent Schedule / Flight Coverage / the summary bar are still
 * showing the PREVIOUS revision underneath. Whatever tab the planner is
 * currently on stays selected -- this component never switches tabs; the
 * tab's own content simply re-renders once the page's shared state
 * updates, since it's the exact same state every tab already reads from.
 *
 * STRONG CONSISTENCY CHECK: a resolved refetch is still not, by itself,
 * proof the planner is looking at the revision Make Planning just wrote
 * (see the read-after-write bug this replaces -- a resolved-but-stale
 * response from an intermediate cache or a lagging read replica looks
 * identical to a fresh one from the client's point of view). So this
 * compares the `revision` the POST response says it just persisted
 * against the `revision` the refetched plan actually reports, and treats
 * a mismatch as failure, not success -- retrying the refetch a few times
 * (REVISION_POLL_ATTEMPTS) before giving up honestly. Success is shown
 * ONLY once the two numbers agree; the persisted summary counts (which
 * describe that same persisted revision) are never shown before that.
 */
export function MakePlanningButton({ onDone }: { onDone: () => Promise<FetchedPlanIdentity | null> }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "blocked">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [summary, setSummary] = useState<PlanSummary | null>(null);

  async function handleClick() {
    setState("loading");
    setMessage(null);
    setSummary(null);
    let data: { plan?: FetchedPlanIdentity; revision?: number; summary?: PlanSummary; error?: string };
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

    // The exact plan id/revision this POST just committed -- what every
    // subsequent refetch must agree with before this shows success.
    const persistedPlanId = data.plan?.id;
    const persistedRevision = data.revision ?? data.plan?.revision;

    // Generation succeeded and is persisted at this point -- but the
    // summary/success state below must not appear until the page has
    // actually refetched and rendered THIS EXACT revision (see the doc
    // comment above). A refetch that resolves with an older revision is
    // treated the same as one that failed outright: retried, then
    // surfaced honestly if it never catches up.
    try {
      let fetched: FetchedPlanIdentity | null = null;
      let matched = false;
      for (let attempt = 1; attempt <= REVISION_POLL_ATTEMPTS && !matched; attempt++) {
        fetched = await onDone();
        matched =
          persistedRevision === undefined ||
          persistedPlanId === undefined ||
          (fetched?.id === persistedPlanId && fetched?.revision === persistedRevision);
        if (!matched && attempt < REVISION_POLL_ATTEMPTS) await sleep(REVISION_POLL_DELAY_MS);
      }

      if (!matched) {
        setState("blocked");
        setMessage(
          `Planning was generated and saved (revision ${persistedRevision}), but the page kept loading an older revision` +
            (fetched ? ` (revision ${fetched.revision})` : "") +
            ` after ${REVISION_POLL_ATTEMPTS} attempts -- refresh to see the new plan, and report this if it persists.`
        );
        return;
      }

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
        <p className={`text-xs max-w-sm text-right ${summary.blockingConflicts > 0 ? "text-bad-700" : "text-muted"}`}>
          {summary.blockingConflicts > 0 ? "Planning generated with conflicts" : "Planning generated"} —{" "}
          {summary.managedFlights} managed flights · {summary.dutiesAssigned} duties assigned · {summary.staffingGaps} staffing gaps ·{" "}
          {summary.warnings} warnings · {summary.blockingConflicts} blocking conflicts · {summary.hardRestViolations} persisted hard violations
        </p>
      )}
      {message && <p className="text-xs text-bad-700 max-w-sm text-right">{message}</p>}
    </div>
  );
}
