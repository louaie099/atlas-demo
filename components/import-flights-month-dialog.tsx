"use client";

import { useState } from "react";
import { Button, Card, Badge } from "./ui";
import { weekStartFor, weekRangeLabelFor } from "@/lib/flight-date";

interface ParsedFlightRow {
  rowNumber: number;
  raw: Record<string, string>;
  status: "ready" | "warning" | "rejected";
  problems: string[];
}

interface WeekBreakdown {
  weekStart: string;
  total: number;
  ready: number;
  warnings: number;
  rejected: number;
  problemRows: ParsedFlightRow[]; // warning/rejected rows that genuinely belong to this week
  imported: number | null; // filled in after Confirm; null before
}

/**
 * Import Flights for Month -- a month-wide counterpart to
 * ImportFlightsDialog (see that file's own doc comment for the single-week
 * preview/confirm pattern this mirrors). Per product decision (2026-10-03):
 * BOTH entry points stay -- this one lets management hand ATLAS one CSV
 * spanning the whole month's flight program, without first splitting it
 * into one file per week themselves; the per-week dialog on the Flight
 * Schedule tab remains for importing into just the currently-viewed week.
 *
 * No backend change: the existing /api/flights/import (preview) and
 * /api/flights/import/commit routes already validate and scope EVERY row
 * by its own flight_date's real week against the week_start the call is
 * made for (lib/flight-import.ts's validateRow) -- a row for a different
 * week is deterministically rejected there, never silently misfiled. This
 * component simply calls that same pair of routes once per week the
 * selected month overlaps, with the SAME csv text each time, and
 * aggregates the results into a per-week breakdown (per product decision).
 * A row rejected by one week's call purely because it belongs to ANOTHER
 * week in this same loop is NOT shown as a problem here -- it is real
 * signal only for the one week whose own preview call reports it against
 * its own rows (filtered client-side by recomputing the row's own week
 * from its flight_date, the same way the server does).
 */
export function ImportFlightsForMonthDialog({
  monthLabel,
  weeksInMonth,
  onImported,
}: {
  monthLabel: string;
  weeksInMonth: string[];
  onImported: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [breakdown, setBreakdown] = useState<WeekBreakdown[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [committed, setCommitted] = useState(false);

  function reset() {
    setCsvText(null);
    setFileName(null);
    setBreakdown(null);
    setError(null);
    setCommitted(false);
  }

  async function handleFile(file: File) {
    setError(null);
    setCommitted(false);
    const text = await file.text();
    setCsvText(text);
    setFileName(file.name);
    setBusy(true);
    try {
      const perWeek = await Promise.all(
        weeksInMonth.map(async (weekStart): Promise<WeekBreakdown | { error: string }> => {
          const res = await fetch("/api/flights/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ csv: text, week_start: weekStart }),
          });
          const data = await res.json();
          if (!res.ok) return { error: data.error ?? `Preview failed for ${weekStart}.` };
          const rows = (data.rows as ParsedFlightRow[]).filter((r) => weekStartFor(r.raw.flight_date) === weekStart);
          return {
            weekStart,
            total: rows.length,
            ready: rows.filter((r) => r.status === "ready").length,
            warnings: rows.filter((r) => r.status === "warning").length,
            rejected: rows.filter((r) => r.status === "rejected").length,
            problemRows: rows.filter((r) => r.status !== "ready"),
            imported: null,
          };
        })
      );
      const firstError = perWeek.find((w): w is { error: string } => "error" in w);
      if (firstError) {
        setError(firstError.error);
        return;
      }
      setBreakdown(perWeek as WeekBreakdown[]);
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    if (!csvText || !breakdown) return;
    setBusy(true);
    setError(null);
    try {
      const results: WeekBreakdown[] = [];
      // Sequential, not Promise.all: each commit re-validates against
      // "already persisted" state fresh (see commit route's own doc
      // comment) -- running them one at a time keeps that re-validation
      // meaningful rather than racing several inserts against the same
      // stale existingKeys snapshot.
      for (const week of breakdown) {
        const res = await fetch("/api/flights/import/commit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ csv: csvText, week_start: week.weekStart }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(`${data.error ?? "Import failed"} (week of ${week.weekStart}) -- weeks already imported above this one were NOT rolled back.`);
          setBreakdown(results.concat(breakdown.slice(results.length)));
          return;
        }
        results.push({ ...week, imported: data.imported as number });
      }
      setBreakdown(results);
      setCommitted(true);
      onImported();
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)} className="self-start">
        Import Flights for Month
      </Button>
    );
  }

  const totals = breakdown?.reduce(
    (acc, w) => ({
      total: acc.total + w.total,
      ready: acc.ready + w.ready,
      warnings: acc.warnings + w.warnings,
      rejected: acc.rejected + w.rejected,
      imported: acc.imported + (w.imported ?? 0),
    }),
    { total: 0, ready: 0, warnings: 0, rejected: 0, imported: 0 }
  );

  return (
    <Card className="flex flex-col gap-4 max-w-3xl">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-semibold text-ink">Import Flights for {monthLabel}</h3>
          <p className="text-xs text-muted mt-0.5">
            One CSV for the whole month -- each row is automatically placed into its own real week
            ({weeksInMonth.length} weeks this month). This is flight-program input only; click Make Planning on each
            week afterward to generate coverage from the updated schedule.
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

      {committed ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-good-700 bg-good-50 rounded-lg px-3 py-2">
            Imported {totals?.imported ?? 0} flight{totals?.imported === 1 ? "" : "s"} across {weeksInMonth.length} weeks.
          </p>
          {breakdown!.map((w) => (
            <div key={w.weekStart} className="flex items-center justify-between text-sm px-3 py-1.5 border border-border rounded-lg">
              <span className="text-ink">{weekRangeLabelFor(w.weekStart)}</span>
              <span className="text-muted">{w.imported ?? 0} imported</span>
            </div>
          ))}
        </div>
      ) : (
        <>
          {!breakdown && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">
                CSV file — columns: flight_number, airline, origin, destination, flight_date, scheduled_departure,
                aircraft (scheduled_arrival, booking_pressure, terminal optional). flight_date decides which week each
                row lands in.
              </span>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFile(file);
                }}
                className="border border-border rounded-lg px-3 py-2"
              />
            </label>
          )}

          {fileName && <p className="text-xs text-muted">{fileName}</p>}

          {totals && (
            <div className="flex items-center gap-2 flex-wrap">
              <Badge tone="neutral">{totals.total} rows</Badge>
              <Badge tone="good">{totals.ready} ready</Badge>
              <Badge tone="warn">{totals.warnings} warnings</Badge>
              <Badge tone="bad">{totals.rejected} rejected</Badge>
            </div>
          )}

          {breakdown && (
            <div className="flex flex-col gap-2 max-h-80 overflow-y-auto">
              {breakdown.map((w) => (
                <div key={w.weekStart} className="border border-border rounded-lg">
                  <div className="flex items-center justify-between px-3 py-2 bg-surface">
                    <span className="text-sm font-medium text-ink">{weekRangeLabelFor(w.weekStart)}</span>
                    <div className="flex items-center gap-1.5">
                      <Badge tone="good">{w.ready} ready</Badge>
                      <Badge tone="warn">{w.warnings} warnings</Badge>
                      <Badge tone="bad">{w.rejected} rejected</Badge>
                    </div>
                  </div>
                  {w.problemRows.length > 0 && (
                    <div className="divide-y divide-border">
                      {w.problemRows.map((r) => (
                        <div key={r.rowNumber} className="px-3 py-2 text-sm flex items-start gap-2">
                          <Badge tone={r.status === "warning" ? "warn" : "bad"}>row {r.rowNumber}</Badge>
                          <div className="flex-1">
                            <span className="text-ink">
                              {r.raw.flight_number} · {r.raw.flight_date} · {r.raw.origin}→{r.raw.destination}
                            </span>
                            <ul className="text-xs text-muted mt-0.5 list-disc list-inside">
                              {r.problems.map((p, i) => (
                                <li key={i}>{p}</li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {totals && totals.ready + totals.warnings > 0 && (
            <div className="flex gap-2">
              <Button onClick={handleConfirm} disabled={busy}>
                {busy ? "Importing…" : `Confirm Import (${totals.ready + totals.warnings})`}
              </Button>
              <Button variant="ghost" onClick={reset} disabled={busy}>
                Choose a different file
              </Button>
            </div>
          )}
          {totals && totals.ready + totals.warnings === 0 && (
            <p className="text-sm text-muted">No importable rows found for this month's weeks.</p>
          )}
        </>
      )}
    </Card>
  );
}
