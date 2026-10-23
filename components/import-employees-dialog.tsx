"use client";

import { useState } from "react";
import { Button, Card, Badge } from "./ui";
import { useRole } from "./role-context";
import { canManageEmployees } from "@/lib/roles";

interface ParsedEmployeeRow {
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
 * Import Employees -- bulk CSV onboarding for a roster, same two-step
 * shape as ImportFlightsDialog on purpose: PREVIEW parses and validates
 * without writing anything, the person reviews every row (ready/warning/
 * rejected, with the actual reason), then explicitly CONFIRMS before
 * anything is committed. Gated the same as "+ Add Employee" -- only an
 * Administrator may import employees (lib/roles.ts's canManageEmployees),
 * enforced here for the button's own sake and, for real, server-side on
 * both /api/employees/import and its /commit route.
 */
export function ImportEmployeesDialog({ onImported }: { onImported: () => void }) {
  const { role } = useRole();
  const allowed = canManageEmployees(role);

  const [open, setOpen] = useState(false);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [summary, setSummary] = useState<PreviewSummary | null>(null);
  const [rows, setRows] = useState<ParsedEmployeeRow[]>([]);
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
      const res = await fetch("/api/employees/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: text }),
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
      const res = await fetch("/api/employees/import/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: csvText }),
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
      <span title={allowed ? undefined : "Administrator permission required to import employees"}>
        <Button variant="secondary" onClick={() => allowed && setOpen(true)} disabled={!allowed} className="self-start">
          Import Employees
        </Button>
      </span>
    );
  }

  return (
    <Card className="flex flex-col gap-4 max-w-2xl">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-semibold text-ink">Import Employees</h3>
          <p className="text-xs text-muted mt-0.5">
            Onboards workforce profiles only — name, qualifications, current assignment. Nobody imported here gets a
            shift until Weekly Planning generates one, exactly like an employee added by hand.
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
          Imported {committed} employee{committed === 1 ? "" : "s"}.
        </p>
      ) : (
        <>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">
              CSV file — columns: name, skills (required; semicolon-separated), assignment, foreign_company_authorizations
              (semicolon-separated), is_duty_officer (true/false, optional — all but name/skills optional)
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
                    <span className="text-ink">{r.raw.name || "(blank)"}</span>
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
