"use client";

import { useState } from "react";
import { Button, Card, Badge } from "./ui";

interface ParsedFlightRow {
  rowNumber: number;
  raw: Record<string, string>;
  status: "ready" | "warning" | "rejected";
  problems: string[];
}

interface PreviewSummary {
  total: number;
  ready: number;
  warnings: number;
  rejected: number;
}

/**
 * Import Flights -- bulk CSV import for a week's flight program. Two
 * real steps, never one: PREVIEW parses and validates without writing
 * anything, then the person reviews the actual parsed rows (imported/
 * warning/rejected, with reasons) and explicitly CONFIRMS before
 * anything is committed. This is flight-program input only -- it never
 * touches staffing requirements, rosters, or any WeeklyPlan.
 */
export function ImportFlightsDialog({ weekStart, onImported }: { weekStart: string; onImported: () => void }) {
  const [open, setOpen] = useState(false);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [summary, setSummary] = useState<PreviewSummary | null>(null);
  const [rows, setRows] = useState<ParsedFlightRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [committed, setCommitted] = useState<number | null>(null);

  function reset() {
    setCsvText(null);
    setFileName(null);
    setSummary(null);
    setRows([]);
    setError(null);
    setCommitted(null);
  }

  async function handleFile(file: File) {
    setError(null);
    setCommitted(null);
    const text = await file.text();
    setCsvText(text);
    setFileName(file.name);
    setBusy(true);
    try {
      const res = await fetch("/api/flights/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: text, week_start: weekStart }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to parse the file.");
        return;
      }
      setSummary(data.summary);
      setRows(data.rows);
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    if (!csvText) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/flights/import/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: csvText, week_start: weekStart }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Import failed.");
        return;
      }
      setCommitted(data.imported);
      onImported();
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)} className="self-start">
        Import Flights
      </Button>
    );
  }

  return (
    <Card className="flex flex-col gap-4 max-w-2xl">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-semibold text-ink">Import Flights</h3>
          <p className="text-xs text-muted mt-0.5">
            This is flight-program input only — it does not assign staffing. Click Make Planning afterward to generate
            coverage from the updated schedule.
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

      {committed !== null ? (
        <p className="text-sm text-good-700 bg-good-50 rounded-lg px-3 py-2">
          Imported {committed} flight{committed === 1 ? "" : "s"}.
        </p>
      ) : (
        <>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">
              CSV file — columns: flight_number, airline, origin, destination, flight_date, scheduled_departure,
              aircraft (scheduled_arrival, booking_pressure, terminal optional)
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

          {fileName && <p className="text-xs text-muted">{fileName}</p>}

          {summary && (
            <div className="flex items-center gap-2 flex-wrap">
              <Badge tone="neutral">{summary.total} rows</Badge>
              <Badge tone="good">{summary.ready} ready</Badge>
              <Badge tone="warn">{summary.warnings} warnings</Badge>
              <Badge tone="bad">{summary.rejected} rejected</Badge>
            </div>
          )}

          {rows.length > 0 && (
            <div className="max-h-64 overflow-y-auto border border-border rounded-lg divide-y divide-border">
              {rows.map((r) => (
                <div key={r.rowNumber} className="px-3 py-2 text-sm flex items-start gap-2">
                  <Badge tone={r.status === "ready" ? "good" : r.status === "warning" ? "warn" : "bad"}>row {r.rowNumber}</Badge>
                  <div className="flex-1">
                    <span className="text-ink">
                      {r.raw.flight_number} · {r.raw.flight_date} · {r.raw.origin}→{r.raw.destination}
                    </span>
                    {r.problems.length > 0 && (
                      <ul className="text-xs text-muted mt-0.5 list-disc list-inside">
                        {r.problems.map((p, i) => (
                          <li key={i}>{p}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {summary && summary.ready + summary.warnings > 0 && (
            <div className="flex gap-2">
              <Button onClick={handleConfirm} disabled={busy}>
                {busy ? "Importing…" : `Confirm Import (${summary.ready + summary.warnings})`}
              </Button>
              <Button variant="ghost" onClick={reset} disabled={busy}>
                Choose a different file
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
