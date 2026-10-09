"use client";

import { useState } from "react";
import {
  ALERT_SEVERITY_LABEL,
  activeAlerts,
  AlertSeverity,
  OperationalAlert,
  sortAlertsForDisplay,
} from "@/lib/live-ops-alerts";
import { Badge } from "./ui";

const severityTone: Record<AlertSeverity, "bad" | "warn" | "neutral"> = {
  critical: "bad",
  warning: "warn",
  info: "neutral",
};

/**
 * Persistent bell + unread-count dropdown (redesign section 7) — the
 * Attention Center. Driven entirely by `alerts` as reconciled by
 * lib/live-ops-alerts.ts's `reconcileAlerts` on every Live Operations
 * refresh; this component has no notion of how an alert was detected.
 * Clicking an alert calls `onOpen` (navigates/focuses the affected flight
 * — the resolution workflow's first step, section 8) and acknowledges it.
 * "Resolved" alerts stay visible (crossed out, not hidden) so a regulator
 * can see that something WAS wrong and is no longer — never silently
 * forgotten.
 */
export function NotificationCenter({
  alerts,
  onOpen,
}: {
  alerts: OperationalAlert[];
  onOpen: (alert: OperationalAlert) => void;
}) {
  const [open, setOpen] = useState(false);
  const unreadCount = alerts.filter((a) => a.state === "new").length;
  const sorted = sortAlertsForDisplay(alerts);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative flex items-center justify-center w-9 h-9 rounded-full border border-border bg-card hover:bg-gray-50 text-ink"
        aria-label="Notifications"
      >
        <span aria-hidden="true">🔔</span>
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-bad-500 text-white text-[10px] font-semibold flex items-center justify-center">
            {unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-80 max-h-96 overflow-y-auto bg-card border border-border rounded-xl2 shadow-softer z-40 flex flex-col">
            <div className="px-4 py-2.5 border-b border-border text-sm font-semibold text-ink">
              Attention Center{" "}
              <span className="text-muted font-normal">({activeAlerts(alerts).length} active)</span>
            </div>
            {sorted.length === 0 && <p className="px-4 py-4 text-sm text-muted">No notifications yet.</p>}
            {sorted.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => {
                  onOpen(a);
                  setOpen(false);
                }}
                className={`text-left px-4 py-3 border-b border-border last:border-b-0 hover:bg-gray-50 flex flex-col gap-1 ${
                  a.state === "new" ? "bg-brand-50/30" : ""
                } ${a.state === "resolved" ? "opacity-60" : ""}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink">{a.title}</span>
                  <Badge tone={severityTone[a.severity]}>{ALERT_SEVERITY_LABEL[a.severity]}</Badge>
                </div>
                <span className="text-xs text-muted">{a.detail}</span>
                <div className="flex items-center gap-2 text-xs">
                  {a.state === "resolved" && <span className="text-good-700">Resolved</span>}
                  {a.state === "acknowledged" && <span className="text-muted">Acknowledged</span>}
                  {a.reopenedCount > 0 && <span className="text-muted">Reoccurred ×{a.reopenedCount + 1}</span>}
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Immediate toast (section 7) — self-dismissing, also clickable ("[View]"). */
export function NotificationToast({
  alert,
  onView,
  onDismiss,
}: {
  alert: OperationalAlert;
  onView: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="fixed bottom-5 right-5 z-50 w-80 bg-card border border-bad-500/30 rounded-xl2 shadow-softer px-4 py-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-ink">⚠ {alert.title}</span>
        <button type="button" className="text-muted hover:text-ink text-xs" onClick={onDismiss}>
          ✕
        </button>
      </div>
      <p className="text-xs text-muted">{alert.detail}</p>
      <button type="button" onClick={onView} className="self-start text-xs font-medium text-brand-700 hover:underline">
        View
      </button>
    </div>
  );
}
