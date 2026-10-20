"use client";

import { useState } from "react";
import { Button } from "./ui";
import { adminFetch } from "@/lib/admin-key-client";

/**
 * 2026-10-20 UX change: "Reset Demo" used to conflate two different
 * actions — wipe everything, then immediately reload one specific
 * hardcoded dataset — so there was no way to land on a genuinely empty
 * database, and no way to switch datasets without sitting through a full
 * reseed+generate of a dataset you didn't want. These are now two
 * separate controls:
 *
 *   - Reset -> POST /api/reset-empty. Wipes every table, leaves the
 *     database empty (0 employees, 0 flights, nothing). No dataset is
 *     reseeded.
 *   - Load dataset -> one of POST /api/reset, /api/reset-small-demo, or
 *     /api/reset-poc-demo (unchanged, each still does its own full
 *     wipe-then-reseed-then-generate, exactly as before this change) —
 *     picked from the dropdown.
 *
 * Both still go through adminFetch (the same admin-key gating every
 * destructive/admin-only route already requires) and both still reload
 * the page on success, so this is a drop-in replacement for the single
 * button that used to live here.
 */

type DatasetOption = {
  value: string;
  label: string;
  endpoint: string;
};

const DATASETS: DatasetOption[] = [
  { value: "main", label: "Stress Test (main demo)", endpoint: "/api/reset" },
  { value: "small", label: "Small Demo", endpoint: "/api/reset-small-demo" },
  { value: "poc", label: "PoC Demo", endpoint: "/api/reset-poc-demo" },
];

function useAdminAction() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(endpoint: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await adminFetch(endpoint, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Surface the real failure instead of silently reloading into an
        // empty/stale app -- the underlying reset function throwing (bad
        // migration state, a missing table, an RLS policy blocking the
        // service key, etc.) must be visible, not indistinguishable from
        // "it worked but there's nothing to show."
        setError(body?.error ?? `Request failed (${res.status}).`);
        setLoading(false);
        return false;
      }
      window.location.reload();
      return true;
    } catch (err) {
      setError((err as Error).message ?? "Request failed — network error.");
      setLoading(false);
      return false;
    }
  }

  return { run, loading, error, setError };
}

function ResetButton() {
  const [confirming, setConfirming] = useState(false);
  const { run, loading, error, setError } = useAdminAction();

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted">Wipe all data (no dataset reloaded)?</span>
        <Button variant="danger" onClick={() => run("/api/reset-empty")} disabled={loading}>
          {loading ? "Resetting…" : "Confirm"}
        </Button>
        <Button variant="ghost" onClick={() => { setConfirming(false); setError(null); }} disabled={loading}>
          Cancel
        </Button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button variant="secondary" onClick={() => setConfirming(true)}>
        Reset
      </Button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}

function LoadDatasetControl() {
  const [selected, setSelected] = useState<string>(DATASETS[0].value);
  const [confirming, setConfirming] = useState(false);
  const { run, loading, error, setError } = useAdminAction();

  const dataset = DATASETS.find((d) => d.value === selected) ?? DATASETS[0];

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted">Replace all data with “{dataset.label}”?</span>
        <Button variant="danger" onClick={() => run(dataset.endpoint)} disabled={loading}>
          {loading ? "Loading…" : "Confirm"}
        </Button>
        <Button variant="ghost" onClick={() => { setConfirming(false); setError(null); }} disabled={loading}>
          Cancel
        </Button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        className="border border-border rounded-lg px-2 py-1 text-xs text-ink bg-white"
        aria-label="Dataset to load"
      >
        {DATASETS.map((d) => (
          <option key={d.value} value={d.value}>
            {d.label}
          </option>
        ))}
      </select>
      <Button variant="secondary" onClick={() => setConfirming(true)}>
        Load dataset
      </Button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}

export function ResetDemoButton() {
  return (
    <div className="flex items-center gap-3">
      <ResetButton />
      <LoadDatasetControl />
    </div>
  );
}
