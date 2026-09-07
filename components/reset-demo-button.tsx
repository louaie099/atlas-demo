"use client";

import { useState } from "react";
import { Button } from "./ui";

export function ResetDemoButton() {
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleReset() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/reset", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Surface the real failure instead of silently reloading into an
        // empty app -- resetDatabase() throwing (bad migration state, a
        // missing table, an RLS policy blocking the service key, etc.)
        // must be visible, not indistinguishable from "reset succeeded
        // but there's nothing to show."
        setError(body?.error ?? `Reset failed (${res.status}).`);
        setLoading(false);
        return;
      }
      window.location.reload();
    } catch (err) {
      setError((err as Error).message ?? "Reset failed — network error.");
      setLoading(false);
    }
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted">Reset all demo data?</span>
        <Button variant="danger" onClick={handleReset} disabled={loading}>
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
        Reset Demo
      </Button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
