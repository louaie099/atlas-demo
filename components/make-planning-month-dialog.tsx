"use client";

import { useState } from "react";
import { Button, Card, Badge } from "./ui";
import { weekRangeLabelFor } from "@/lib/flight-date";

type WeekOutcome = "generated" | "failed";

interface WeekResult {
  weekStart: string;
  outcome: WeekOutcome;
  /** Real server error text for "failed" -- why generation/regeneration itself failed, never a generic message. */
  error?: string;
}

/**
 * Make Planning for Month -- a month-wide counterpart to
 * MakePlanningButton (see that file's own doc comment for the single-week
 * generate/regenerate state machine this mirrors, and
 * ImportFlightsForMonthDialog for the "run the existing single-week action
 * across every week in the month" pattern this is itself modeled on). Per
 * product decision (2026-10-03): BOTH entry points stay -- the single-week
 * button on this page keeps generating/regenerating just the
 * currently-viewed week, and this one lets a planner generate every week
 * in the month in one action, without having to click into each week
 * individually.
 *
 * No backend change: this calls the SAME /api/planning/make-planning POST
 * the single-week button already calls, once per week this month
 * overlaps.
 *
 * SEQUENTIAL, not Promise.all (see import-flights-month-dialog.tsx for the
 * same reasoning, which applies here too): (1) make-planning's regenerate
 * path re-validates server-side state fresh for whichever week it is
 * called with, so interleaving calls keeps that re-validation meaningful;
 * and (2) -- the more important reason specific to this feature -- week
 * N+1's cross-week continuity (rest boundary, consecutive-day cap, and the
 * OFF/OFF block signal in off-block-continuity.ts) reads week N's plan, so
 * week N must already be persisted before week N+1 is generated.
 * Generating out of month order, or in parallel, would not error, but it
 * could silently produce worse continuity for later weeks than generating
 * in calendar order does.
 *
 * 2026-10-06 (Draft/Publish removal): this dialog used to auto-publish
 * each week immediately after generating it, purely so the NEXT week's
 * OFF/OFF continuity signal would see a "published" predecessor instead of
 * degrading to "unknown" (off-block-continuity.ts's old published-only
 * trust rule). That whole mechanism -- the publish call, the
 * generated/not-published/skipped-already-published outcomes, and the
 * "prior week not yet published" caveat -- is gone now that continuity
 * trusts any persisted predecessor plan (see
 * lib/planning/weekly-plan-service.ts's lookupPriorWeekBoundaryContext).
 * This dialog is back to doing exactly one thing per week: generate or
 * regenerate it from the current flight schedule, in calendar order.
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
      const outcomes: WeekResult[] = [];
      for (const weekStart of weeksInMonth) {
        try {
          const res = await fetch("/api/planning/make-planning", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ week_start: weekStart }),
          });
          const data = await res.json();
          if (!res.ok) {
            // e.g. a plan with human modifications the server refuses to
            // regenerate (409) -- the real reason, not a generic message.
            // Recorded and the loop continues: a failed week must not
            // prevent weeks after it that have not been attempted yet.
            outcomes.push({ weekStart, outcome: "failed", error: data.error ?? "Make Planning failed for an unknown reason." });
            continue;
          }
          outcomes.push({ weekStart, outcome: "generated" });
        } catch {
          outcomes.push({ weekStart, outcome: "failed", error: "Could not reach the server." });
        }
      }

      setResults(outcomes);
      onGenerated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate this month's weeks.");
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
  const failedCount = results?.filter((r) => r.outcome === "failed").length ?? 0;

  return (
    <Card className="flex flex-col gap-4 max-w-3xl">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-semibold text-ink">Make Planning for {monthLabel}</h3>
          <p className="text-xs text-muted mt-0.5">
            Generates (or regenerates) the plan for every one of this month&apos;s {weeksInMonth.length} weeks --
            weeks are processed in calendar order so each week&apos;s continuity is based on the week immediately
            before it.
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
            <Badge tone="bad">{failedCount} failed</Badge>
          </div>

          <div className="flex flex-col gap-2 max-h-80 overflow-y-auto">
            {results.map((r) => (
              <div key={r.weekStart} className="border border-border rounded-lg px-3 py-2 flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-ink">{weekRangeLabelFor(r.weekStart)}</span>
                  <Badge tone={r.outcome === "generated" ? "good" : "bad"}>{r.outcome === "generated" ? "generated" : "failed"}</Badge>
                </div>
                {r.outcome === "failed" && r.error && <p className="text-xs text-bad-700">{r.error}</p>}
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
