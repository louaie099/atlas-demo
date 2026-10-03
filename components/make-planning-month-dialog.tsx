"use client";

import { useState } from "react";
import { Button, Card, Badge } from "./ui";
import { shiftWeek, weekRangeLabelFor } from "@/lib/flight-date";

type WeekOutcome = "generated-published" | "generated-not-published" | "skipped-published" | "failed";

interface WeekResult {
  weekStart: string;
  outcome: WeekOutcome;
  /**
   * Real server error text -- for "failed" this is why generation itself
   * failed; for "generated-not-published" this is publishPlan's own
   * blocking reason (the exact same text the single-week Publish button
   * would show), never a generic message.
   */
  error?: string;
  /**
   * True when, AT THE TIME this week was generated, its immediately prior
   * week (shiftWeek(weekStart, -1)) was not yet PUBLISHED -- meaning the
   * OFF/OFF block-continuity signal degraded to "unknown" for every
   * employee on this week (see off-block-continuity.ts's own doc comment:
   * that signal is gated on a PUBLISHED predecessor, deliberately, unlike
   * rest/fatigue/consecutive-day continuity which also accept a draft).
   * Only meaningful for the two "generated-*" outcomes. Since this dialog
   * now auto-publishes each week right after generating it (see the
   * component doc comment below), this should now be true only for the
   * month's first week, or following a week that itself failed to
   * auto-publish -- not for every week the way it used to be before
   * auto-publish existed.
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
 * AUTO-PUBLISH (product decision, 2026-10-04): immediately after a week
 * generates successfully, this dialog now calls the SAME
 * POST /api/planning/publish endpoint the single-week Publish button
 * uses, for that week, before moving on to the next one. This reuses
 * publishPlan's existing hard guard completely unchanged (see
 * lib/planning/weekly-plan-service.ts) -- a week with unresolved
 * blocking configuration conflicts, rest violations, or hard OFF-day
 * rule violations simply is NOT published (it stays Draft, exactly as
 * clicking Publish manually would leave it), and the real blocking
 * reason is shown per-week in the results list below so it's obvious
 * which weeks still need attention. Ordinary unfilled staffing gaps
 * never block this, same as the manual flow.
 *
 * This is also the structural fix for the "every week shows an OFF/OFF
 * continuity caveat" problem: because each week is now published (when
 * clean) before the next week is generated, week N+1's generation sees a
 * REAL published predecessor in the database, so its continuity signal
 * is correctly known from the start instead of degrading to "unknown"
 * for the whole month. The single-week Publish button on this page is
 * left in place unchanged, both as a way to manually publish a week this
 * dialog left blocked once its issues are fixed, and for the ordinary
 * single-week workflow.
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
      // Mutable going forward (unlike before auto-publish existed): as each
      // week is generated and then auto-published, this map is updated in
      // place so the NEXT week's continuity-caveat check reflects what
      // actually just happened in this run, not just the state from before
      // the run started.
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

        const priorWeekUnpublished = priorWeekNeedsContinuityCaveat(weekStart, statusByWeek);

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

          // Auto-publish, immediately, reusing the exact same endpoint and
          // guard the single-week Publish button calls. A blocked week
          // stays Draft -- never forced through -- and statusByWeek is
          // updated either way so the NEXT week's continuity check (and,
          // more importantly, the NEXT week's real generation, which reads
          // this week's actual persisted status from the database) sees
          // the truth.
          try {
            const publishRes = await fetch("/api/planning/publish", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ planId: data.plan.id }),
            });
            const publishData = await publishRes.json();
            if (publishRes.ok) {
              statusByWeek.set(weekStart, "published");
              outcomes.push({ weekStart, outcome: "generated-published", priorWeekUnpublished });
            } else {
              statusByWeek.set(weekStart, "draft");
              outcomes.push({
                weekStart,
                outcome: "generated-not-published",
                error: publishData.error ?? "Publish was blocked for an unknown reason.",
                priorWeekUnpublished,
              });
            }
          } catch {
            statusByWeek.set(weekStart, "draft");
            outcomes.push({
              weekStart,
              outcome: "generated-not-published",
              error: "Generated, but could not reach the server to publish it.",
              priorWeekUnpublished,
            });
          }
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

  const publishedCount = results?.filter((r) => r.outcome === "generated-published").length ?? 0;
  const notPublishedCount = results?.filter((r) => r.outcome === "generated-not-published").length ?? 0;
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
            continuity is based on the week immediately before it. Each week is automatically published right after
            it generates, as long as it has no unresolved blocking configuration conflicts or hard OFF-day/rest
            violations -- a week with real issues is left as a Draft, with the exact reason shown below, so you can
            review and fix it (then publish it yourself, same as the single-week Publish button).
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
            {busy ? "Generating & publishing…" : "Generate & Publish All Weeks"}
          </Button>
        </div>
      )}

      {results && (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone="good">{publishedCount} generated & published</Badge>
            <Badge tone="warn">{notPublishedCount} generated -- not published</Badge>
            <Badge tone="neutral">{skippedCount} already published</Badge>
            <Badge tone="bad">{failedCount} failed</Badge>
          </div>

          <div className="flex flex-col gap-2 max-h-80 overflow-y-auto">
            {results.map((r) => {
              const tone =
                r.outcome === "generated-published"
                  ? "good"
                  : r.outcome === "generated-not-published"
                  ? "warn"
                  : r.outcome === "skipped-published"
                  ? "neutral"
                  : "bad";
              const label =
                r.outcome === "generated-published"
                  ? "generated & published"
                  : r.outcome === "generated-not-published"
                  ? "generated -- not published"
                  : r.outcome === "skipped-published"
                  ? "already published -- skipped"
                  : "failed";
              return (
                <div key={r.weekStart} className="border border-border rounded-lg px-3 py-2 flex flex-col gap-1">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-ink">{weekRangeLabelFor(r.weekStart)}</span>
                    <Badge tone={tone}>{label}</Badge>
                  </div>
                  {r.outcome === "failed" && r.error && <p className="text-xs text-bad-700">{r.error}</p>}
                  {r.outcome === "generated-not-published" && r.error && (
                    <p className="text-xs text-warn-700">{r.error}</p>
                  )}
                  {(r.outcome === "generated-published" || r.outcome === "generated-not-published") &&
                    r.priorWeekUnpublished && (
                      <p className="text-xs text-warn-700">
                        Prior week not yet published at the time this week was generated, so OFF/OFF continuity was
                        unconfirmed for this week.
                      </p>
                    )}
                </div>
              );
            })}
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
