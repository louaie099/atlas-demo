"use client";

import { useState } from "react";
import { Button } from "./ui";

export function ResetDemoButton() {
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleReset() {
    setLoading(true);
    try {
      await fetch("/api/reset", { method: "POST" });
      window.location.reload();
    } finally {
      setLoading(false);
      setConfirming(false);
    }
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted">Reset all demo data?</span>
        <Button variant="danger" onClick={handleReset} disabled={loading}>
          {loading ? "Resetting…" : "Confirm"}
        </Button>
        <Button variant="ghost" onClick={() => setConfirming(false)} disabled={loading}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <Button variant="secondary" onClick={() => setConfirming(true)}>
      Reset Demo
    </Button>
  );
}
