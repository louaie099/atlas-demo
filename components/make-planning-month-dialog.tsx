"use client";

import { useState } from "react";
import { Button, Card, Badge } from "./ui";
import { shiftWeek, weekRangeLabelFor } from "@/lib/flight-date";

type WeekOutcome = "generated" | "skipped-published" | "failed";

interface WeekResult {
  weekStart: string;
  outcome: WeekOutcome;
  /** Real server error text for a failed week -- never a generic message. */
  error?: string;
  /**
   * True when, AT THE TIME this week was generated, its immediately prior
   * week (shiftWeek(weekStart, -1)) was not PUBLISHED -- meaning the
   * OFF/OFF block-continuity signal degraded to "unknown" for every
   * employee on this week (see off-block-continuity.ts's own doc comment:
   * that signal is gated on a PUBLISHED predecessor, deliberately, unlike
   * rest/fatigue/consecutive-day continuity which also accept a draft).
   * Only meaningful when outcome === "generated".
   */
  priorWeekUnpublished?: boolean;
}

/**
 * Pure helper so "does this week need a continuity caveat" is testable in
 * isolation from the fetch/loop orchestration below. `statusByWeek` holds
 * each week's plan status AS OBSERVED BEFORE this run started (a snapshot
 * taken once up front -- see the component's own doc comment for why that
 * snapshot stays valid for the whole run: nothing this dialog does ever
 * publishes a plan, so a week's published/not-published state cannot
 * change between the snapshot and this week's turn in the loop).
 */
export function priorWeekNeedsContinuityCaveat(
  weekStart: string,
  statusByWeek: Map<string, "draft" | "published" | "none">
): boolean {
  const priorWeekStart = shiftWeek(weekStart, -1);
  const priorStatus = statusByWeek.get(priorWeekStart);
  // Unknown (prior week outside the fetched month, e.g. the month's first
  // week) is treated the same as "not published" -- it is honestly not
  // confirmed published either way, so the caveat still applies.
  return priorStatus !== "published";
}

/**
 * Make Planning for Month -- a month-wide counterpart to
 * MakePlanningButton (see that file's own doc comment for the single-week
 * generate/regenerate state machine this mirrors, and
 * ImportFlightsForMonthDialog for the "run the existing single-week
 * action across every week in the month" pattern this is itself modeled
 * on). Per product decision (2026-10-03): BOTH entry points stay -- the
 * single-week button on this page keeps generating/regenerating just the
 * currently-viewed week, and this one lets a planner generate every week
 * in the month in one action, without having to click into each week
 * individually (the bug this fixes: most weeks in a month never had Make
 * Planning run on them at all, so they carry no roster/duty data -- which
 * is what was surfacing as Company Team requirements showing 0 assigned
 * for those weeks, not a scoring or authorization bug).
 *
 * No backend change: this calls the SAME /api/planning/make-planning POST
 * the single-week button already calls, once per week this month
 * overlaps, plus /api/planning/weekly-view (GET) once per week up front to
 * learn each week's current status. weekly-view is already the ONLY
 * existing route that reports a week's plan status (`plan.status`) -- it
 * is heavier than a dedicated "status only" endpoint would be (it also
 * returns flights/roster/schedule/zoneCoverage), but adding a new route
 * just to shave that would be a backend change this feature does not
 * need; reusing the existing one keeps this entirely additive.
 *
 * SEQUENTIAL, not Promise.all, for two independent reasons (see
 * import-flights-month-dialog.tsx for the first one, which applies here
 * too): (1) make-planning's regenerate path re-validates server-side
 * state fresh for whichever week it is called with, so interleaving calls
 * keeps that re-validation meaningful; and (2) -- the more important
 * reason specific to this feature -- week N+1's cross-week continuity
 * (rest boundary, consecutive-day cap, and especially the OFF/OFF block
 * signal in off-block-continuity.ts) reads week N's plan, so week N must
 * already be persisted before week N+1 is generated. Generating out of
 * month order, or in parallel, would not error, but it could silently
 * produce WORSE continuity for later weeks than generating in calendar
 * order does.
 *
 * This dialog never publishes anything -- it only creates or regenerates
 * DRAFTS, exactly like the single-week button does. Publishing stays a
 * separate, explicit, per-week manual action.
 */
export function MakePlanningForMonthDialog({
  monthLabel,
  weeksInMonth,
  onGenerated,
}: {
  monthLabel: string;
  weeksInMonth: string[];
  onGenerated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<WeekResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setResults(null);
    setError(null);
  }

  async function handleGenerate() {
    setBusy(true);
    setError(null);
    setResults(null);
    try {
      // Snapshot every week's CURRENT status up front, in parallel -- these
      // are plain reads with no ordering dependency on each other (unlike
      // the generate calls below). The snapshot stays valid for the whole
      // run: this dialog never publishes a plan, so a week's
      // published/not-published state cannot change between this snapshot
      // and the moment the loop below reaches it.
      const statusEntries = await Promise.all(
        weeksInMonth.map(async (weekStart): Promise<[string, "draft" | "published" | "none"]> => {
          const res = await fetch(`/api/planning/weekly-view?week_start=${weekStart}`, { cache: "no-store" });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error ?? `Could not load status for week ${weekStart}.`);
          const status: "draft" | "published" | "none" = data.plan ? data.plan.status : "none";
          return [weekStart, status];
        })
      );
      const statusByWeek = new Map(statusEntries);

      const outcomes: WeekResult[] = [];
      for (const weekStart of weeksInMonth) {
        const currentStatus = statusByWeek.get(weekStart) ?? "none";
        if (currentStatus === "published") {
          // Skip client-side rather than calling make-planning and letting
          // the server's own 409 land here -- the server already refuses
          // this correctly, but surfacing it as "already published,
          // skipped" reads honestly, not like a spurious failure, and this
          // also saves the round trip.
          outcomes.push({ weekStart, outcome: "skipped-published" });
          continue;
        }

        try {
          const res = await fetch("/api/planning/make-planning", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ week_start: weekStart }),
          });
          const data = await res.json();
          if (!res.ok) {
            // e.g. a draft with human modifications the server refuses to
            // regenerate (409) -- the real reason, not a generic message.
            // Recorded and the loop continues: a failed week must not
            // prevent weeks after it that have not been attempted yet.
            outcomes.push({ weekStart, outcome: "failed", error: data.error ?? "Make Planning failed for an unknown reason." });
            continue;
          }
          outcomes.push({
            weekStart,
            outcome: "generated",
            priorWeekUnpublished: priorWeekNeedsContinuityCaveat(weekStart, statusByWeek),
          });
        } catch {
          outcomes.push({ weekStart, outcome: "failed", error: "Could not reach the server." });
        }
      }

      setResults(outcomes);
      onGenerated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not determine current plan status for this month's weeks.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)} className="self-start">
        Make Planning for Month
      </Button>
    );
  }

  const generatedCount = results?.filter((r) => r.outcome === "generated").length ?? 0;
  const skippedCount = results?.filter((r) => r.outcome === "skipped-published").length ?? 0;
  const failedCount = results?.filter((r) => r.outcome === "failed").length ?? 0;

  return (
    <Card className="flex flex-col gap-4 max-w-3xl">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-semibold text-ink">Make Planning for {monthLabel}</h3>
          <p className="text-xs text-muted mt-0.5">
            Generates (or regenerates) a draft plan for every one of this month&apos;s {weeksInMonth.length} weeks that
            does not already have a published plan -- weeks are processed in calendar order so each week&apos;s
            continuity is based on the week immediately before it. This creates DRAFTS only; it never publishes
            anything -- publishing stays a separate, explicit action per week.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            reset();
          }}
          className="text-muted hover:text-ink text-sm px-2 py-1 rounded-lg hover:bg-surface"
        >
          Close
        </button>
      </div>

      {error && <p className="text-sm text-bad-700 bg-bad-50 rounded-lg px-3 py-2">{error}</p>}

      {!results && (
        <div className="flex gap-2">
          <Button onClick={handleGenerate} disabled={busy}>
            {busy ? "Generating…" : "Generate All Weeks"}
          </Button>
        </div>
      )}

      {results && (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone="good">{generatedCount} generated</Badge>
            <Badge tone="neutral">{skippedCount} already published</Badge>
            <Badge tone="bad">{failedCount} failed</Badge>
          </div>

          <div className="flex flex-col gap-2 max-h-80 overflow-y-auto">
            {results.map((r) => (
              <div key={r.weekStart} className="border border-border rounded-lg px-3 py-2 flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-ink">{weekRangeLabelFor(r.weekStart)}</span>
                  <Badge tone={r.outcome === "generated" ? "good" : r.outcome === "skipped-published" ? "neutral" : "bad"}>
                    {r.outcome === "generated" ? "generated" : r.outcome === "skipped-published" ? "already published -- skipped" : "failed"}
                  </Badge>
                </div>
                {r.outcome === "failed" && r.error && <p className="text-xs text-bad-700">{r.error}</p>}
                {r.outcome === "generated" && r.priorWeekUnpublished && (
                  <p className="text-xs text-warn-700">
                    Generated -- prior week not yet published, so OFF/OFF continuity is unconfirmed for this week.
                  </p>
                )}
              </div>
            ))}
          </div>

          <div>
            <Button variant="ghost" onClick={reset} disabled={busy}>
              Run again
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
