"use client";

import { useState } from "react";
import { shiftWeek, weekLabelFor, weekStartFor } from "@/lib/flight-date";
import { Button } from "./ui";

function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Jump directly to any Monday-Sunday week, rather than clicking
 * Previous/Next one step at a time. A small popover (never a full calendar
 * grid permanently on screen) listing a short window of weeks around
 * whatever week is currently selected, plus a raw date input so navigation
 * is never limited to that window or to a week that already has data --
 * an empty future week must be just as selectable as one with a plan.
 *
 * All date math goes through lib/flight-date.ts (shiftWeek/weekLabelFor/
 * weekStartFor) -- no independent date arithmetic here.
 */
export function WeekPicker({ weekStart, onSelect }: { weekStart: string | null; onSelect: (weekStart: string) => void }) {
  const [open, setOpen] = useState(false);
  const anchor = weekStart ?? weekStartFor(todayISO());
  const weeks = Array.from({ length: 10 }, (_, i) => shiftWeek(anchor, i - 4)); // 4 back, current, 5 forward

  return (
    <div className="relative">
      <button
        className="font-medium text-ink hover:text-brand-700 underline decoration-dotted underline-offset-4"
        onClick={() => setOpen((o) => !o)}
      >
        {weekStart ? weekLabelFor(weekStart) : "Select week"}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute z-40 top-full mt-2 left-1/2 -translate-x-1/2 w-64 bg-white border border-border rounded-xl2 shadow-softer p-2 flex flex-col gap-1">
            <Button
              variant="secondary"
              className="!py-1.5 text-xs"
              onClick={() => {
                onSelect(weekStartFor(todayISO()));
                setOpen(false);
              }}
            >
              Today
            </Button>
            <div className="max-h-64 overflow-y-auto flex flex-col gap-0.5 mt-1">
              {weeks.map((w) => (
                <button
                  key={w}
                  onClick={() => {
                    onSelect(w);
                    setOpen(false);
                  }}
                  className={`text-left text-sm px-2 py-1.5 rounded-lg hover:bg-gray-50 ${
                    w === weekStart ? "bg-brand-50 text-brand-700 font-medium" : "text-ink"
                  }`}
                >
                  {weekLabelFor(w)}
                </button>
              ))}
            </div>
            <div className="border-t border-border pt-1.5 mt-1">
              <label className="text-xs text-muted block mb-1">Jump to any date</label>
              <input
                type="date"
                className="border border-border rounded-lg px-2 py-1 text-sm w-full"
                onChange={(e) => {
                  if (!e.target.value) return;
                  onSelect(weekStartFor(e.target.value));
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
