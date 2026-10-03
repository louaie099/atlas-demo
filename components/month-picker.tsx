"use client";

import { useState } from "react";
import { monthLabelFor, shiftMonth, monthStartFor } from "@/lib/flight-date";
import { Button } from "./ui";

function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Month-level counterpart to WeekPicker (see that file's own doc comment)
 * -- the planning HORIZON selector for Monthly Planning. A small popover
 * listing a short window of months around whatever is currently selected,
 * plus a raw month input so navigation is never limited to that window.
 * Selecting a month never fetches anything itself -- the caller (MonthNav
 * -> app/planning/page.tsx) decides which week inside the new month to
 * actually load, exactly the way WeekPicker only ever emits a weekStart
 * for the caller to act on.
 */
export function MonthPicker({ monthStart, onSelect }: { monthStart: string | null; onSelect: (monthStart: string) => void }) {
  const [open, setOpen] = useState(false);
  const anchor = monthStart ?? monthStartFor(todayISO());
  const months = Array.from({ length: 10 }, (_, i) => shiftMonth(anchor, i - 4)); // 4 back, current, 5 forward

  return (
    <div className="relative">
      <button
        className="font-semibold text-lg text-ink hover:text-brand-700 underline decoration-dotted underline-offset-4"
        onClick={() => setOpen((o) => !o)}
      >
        {monthStart ? monthLabelFor(monthStart) : "Select month"}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute z-40 top-full mt-2 left-1/2 -translate-x-1/2 w-56 bg-white border border-border rounded-xl2 shadow-softer p-2 flex flex-col gap-1">
            <Button
              variant="secondary"
              className="!py-1.5 text-xs"
              onClick={() => {
                onSelect(monthStartFor(todayISO()));
                setOpen(false);
              }}
            >
              Current month
            </Button>
            <div className="max-h-64 overflow-y-auto flex flex-col gap-0.5 mt-1">
              {months.map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    onSelect(m);
                    setOpen(false);
                  }}
                  className={`text-left text-sm px-2 py-1.5 rounded-lg hover:bg-gray-50 ${
                    m === monthStart ? "bg-brand-50 text-brand-700 font-medium" : "text-ink"
                  }`}
                >
                  {monthLabelFor(m)}
                </button>
              ))}
            </div>
            <div className="border-t border-border pt-1.5 mt-1">
              <label className="text-xs text-muted block mb-1">Jump to any month</label>
              <input
                type="month"
                className="border border-border rounded-lg px-2 py-1 text-sm w-full"
                onChange={(e) => {
                  if (!e.target.value) return;
                  onSelect(monthStartFor(`${e.target.value}-01`));
                  setOpen(false);
                }}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
