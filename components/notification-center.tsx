"use client";

import { useState } from "react";
import {
  LiveOpsNotification,
  NOTIFICATION_SEVERITY_LABEL,
  NotificationSeverity,
} from "@/lib/live-ops-notifications";
import { Badge } from "./ui";

const severityTone: Record<NotificationSeverity, "bad" | "warn" | "neutral"> = {
  critical: "bad",
  warning: "warn",
  info: "neutral",
};

/**
 * Persistent bell + unread-count dropdown (redesign section 7). Clicking a
 * notification calls `onOpen` (navigates/focuses the affected flight — the
 * resolution workflow's first step, section 8) and marks it acknowledged.
 */
export function NotificationCenter({
  notifications,
  onOpen,
}: {
  notifications: LiveOpsNotification[];
  onOpen: (notification: LiveOpsNotification) => void;
}) {
  const [open, setOpen] = useState(false);
  const unreadCount = notifications.filter((n) => n.state === "new").length;

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
            <div className="px-4 py-2.5 border-b border-border text-sm font-semibold text-ink">Attention Center</div>
            {notifications.length === 0 && (
              <p className="px-4 py-4 text-sm text-muted">No notifications yet.</p>
            )}
            {[...notifications]
              .sort((a, b) => b.createdAt - a.createdAt)
              .map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => {
                    onOpen(n);
                    setOpen(false);
                  }}
                  className={`text-left px-4 py-3 border-b border-border last:border-b-0 hover:bg-gray-50 flex flex-col gap-1 ${
                    n.state === "new" ? "bg-brand-50/30" : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-ink">{n.title}</span>
                    <Badge tone={severityTone[n.severity]}>{NOTIFICATION_SEVERITY_LABEL[n.severity]}</Badge>
                  </div>
                  <span className="text-xs text-muted">{n.detail}</span>
                  {n.state === "resolved" && <span className="text-xs text-good-700">Resolved</span>}
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
  notification,
  onView,
  onDismiss,
}: {
  notification: LiveOpsNotification;
  onView: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="fixed bottom-5 right-5 z-50 w-80 bg-card border border-bad-500/30 rounded-xl2 shadow-softer px-4 py-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-ink">⚠ {notification.title}</span>
        <button type="button" className="text-muted hover:text-ink text-xs" onClick={onDismiss}>
          ✕
        </button>
      </div>
      <p className="text-xs text-muted">{notification.detail}</p>
      <button type="button" onClick={onView} className="self-start text-xs font-medium text-brand-700 hover:underline">
        View
      </button>
    </div>
  );
}
