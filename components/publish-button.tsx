"use client";

import { useState } from "react";
import { Button } from "./ui";

// The minimal shape this component needs from whatever `onDone` resolves
// with -- mirrors MakePlanningButton's FetchedPlanIdentity exactly, plus
// `status` since that's the one field this button's own consistency check
// cares about.
interface FetchedPlanIdentity {
  id: string;
  revision: number;
  status: "draft" | "published";
}

const STATUS_POLL_ATTEMPTS = 5;
const STATUS_POLL_DELAY_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The single user-facing trigger for /api/planning/publish --
 * weekly-plan-service.ts's publishPlan has been fully built, guarded, and
 * tested since the Weekly/Monthly Planning lifecycle milestone, but until
 * now nothing in the UI ever called it: the Generate -> Review -> Adjust
 * -> Publish strip (DraftLifecycle, above) deliberately renders "Publish"
 * as muted, non-interactive text, because there was no real control wired
 * to it. This is that control -- added once there WAS something for it to
 * call (2026-10-03, the demo milestone).
 *
 * Mirrors MakePlanningButton's own structure closely on purpose (same
 * file, same patterns a planner already knows from that button):
 *  - The server decides what actually happens (publish / blocked-by-a-
 *    hard-violation / blocked-because-already-published) -- this
 *    component only shows the outcome, never silently retries or hides a
 *    block.
 *  - A block surfaces the EXACT reason publishPlan returned -- including,
 *    as of the 2026-10-03 hard-OFF-rule-guard patch, a specific count of
 *    unresolved BLOCKING configuration conflicts, persisted rest
 *    violations, or hard OFF-day rule violations (insufficient OFF days /
 *    a separated, non-consecutive OFF block) -- never a generic "could not
 *    publish" message.
 *  - `onDone` MUST be the page's refetch of /api/planning/weekly-view
 *    (loadWeeklyPlan) and MUST resolve once every dependent view's state
 *    has actually been set from the new response. This component stays in
 *    "loading" through that entire await -- a planner must never see
 *    "Published" while the status badge/DraftLifecycle strip above still
 *    shows "Draft Weekly Plan" underneath.
 *  - STRONG CONSISTENCY CHECK, same reasoning as MakePlanningButton's own
 *    revision-poll: a resolved refetch is not, by itself, proof the page
 *    is showing the NEW published status (an intermediate cache or a
 *    lagging read replica can resolve with a stale "draft" that looks
 *    identical to a fresh read). So this polls until the refetched plan's
 *    id matches AND its status reads "published", retrying a few times
 *    before giving up honestly rather than claiming success on a stale
 *    read.
 *
 * Only ever rendered for a plan whose status is currently "draft" (see
 * app/planning/page.tsx) -- a published plan has nothing left to publish,
 * and the page's own status badge already communicates that.
 */
export function PublishButton({
  planId,
  onDone,
}: {
  planId: string;
  onDone: () => Promise<FetchedPlanIdentity | null>;
}) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "blocked">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleClick() {
    setState("loading");
    setMessage(null);
    let data: { plan?: FetchedPlanIdentity; error?: string };
    try {
      const res = await fetch("/api/planning/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId }),
      });
      data = await res.json();
      if (!res.ok) {
        // The exact reason publishPlan refused -- e.g. "This draft cannot
        // be published: it still has 2 unresolved hard OFF-day rule
        // violation(s) (...)." Never reworded or generalized.
        setState("blocked");
        setMessage(data.error ?? "Publish was blocked for an unknown reason.");
        return;
      }
    } catch {
      setState("blocked");
      setMessage("Publish failed -- could not reach the server.");
      return;
    }

    try {
      let fetched: FetchedPlanIdentity | null = null;
      let matched = false;
      for (let attempt = 1; attempt <= STATUS_POLL_ATTEMPTS && !matched; attempt++) {
        fetched = await onDone();
        matched = fetched?.id === planId && fetched?.status === "published";
        if (!matched && attempt < STATUS_POLL_ATTEMPTS) await sleep(STATUS_POLL_DELAY_MS);
      }

      if (!matched) {
        setState("blocked");
        setMessage(
          `The plan was published and saved, but the page kept loading it as still a draft` +
            (fetched ? ` (status: ${fetched.status})` : "") +
            ` after ${STATUS_POLL_ATTEMPTS} attempts -- refresh to see the published plan, and report this if it persists.`
        );
        return;
      }

      setState("done");
    } catch {
      // The publish IS safely persisted -- only reloading the page's own
      // view of it failed. Never claim anything about what's visible here.
      setState("blocked");
      setMessage("The plan was published and saved, but the page could not reload it -- refresh to see the published plan.");
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button variant="secondary" onClick={handleClick} disabled={state === "loading" || state === "done"}>
        {state === "loading" ? "Publishing…" : state === "done" ? "Published" : "Publish"}
      </Button>
      {message && <p className="text-xs text-bad-700 max-w-sm text-right">{message}</p>}
    </div>
  );
}
