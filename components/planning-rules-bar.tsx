"use client";

import { useEffect, useState } from "react";
import { ResolvedLaborRules, RuleSeverity } from "@/lib/labor-rules";
import { FatigueConfig } from "@/lib/fatigue-config";
import { Button } from "./ui";
import { PlanningRulesSheet } from "./planning-rules-sheet";

export interface RulesResponse {
  resolved: ResolvedLaborRules;
  severity: Record<string, RuleSeverity>;
  fatigue: FatigueConfig;
}

/**
 * Compact, always-visible summary of the confirmed planning rules
 * currently in force, rendered immediately beside MakePlanningButton (see
 * app/planning/page.tsx) -- this is what makes rules EXPLICIT before Make
 * Planning, rather than something a planner only discovers from the
 * generated result. Clicking "Edit rules" opens PlanningRulesSheet, the
 * full drawer where every field can actually be changed.
 *
 * Deliberately just one line -- a compact summary + drawer, never a
 * settings dashboard occupying the page. A `*` (with a title tooltip) on
 * any value that is confirmed as a PRINCIPLE but not yet evaluable (a null
 * reference period, a null obligation) -- never silently omitted, and
 * never guessed as if it were a real number.
 */
export function PlanningRulesBar() {
  const [data, setData] = useState<RulesResponse | null>(null);
  const [open, setOpen] = useState(false);

  function load() {
    fetch("/api/planning/rules", { cache: "no-store" })
      .then((r) => r.json())
      .then(setData);
  }

  useEffect(load, []);

  if (!data) {
    return <p className="text-xs text-muted">Loading planning rules…</p>;
  }

  const { resolved } = data;
  const obligation =
    resolved.workingHoursObligationHours === null
      ? <span title="Confirmed as a principle, but no real target has been confirmed yet — not currently evaluated.">Weekly obligation not confirmed*</span>
      : <span>Weekly obligation {resolved.workingHoursObligationHours}h</span>;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2 flex-wrap justify-end">
        <p className="text-xs text-muted text-right">
          {resolved.normalWeeklyWorkDays} WORK / {resolved.normalWeeklyOffDays} OFF{resolved.normalOffDaysConsecutive ? " together" : ""} · Min rest{" "}
          {resolved.minimumRestHours}h · {obligation} · Fatigue {data.fatigue.enabled ? "On" : "Off"}
        </p>
        <Button variant="ghost" onClick={() => setOpen(true)} className="!px-2 !py-1 !shadow-none text-xs underline">
          Edit rules
        </Button>
      </div>
      {open && (
        <PlanningRulesSheet
          data={data}
          onClose={() => setOpen(false)}
          onSaved={(next) => {
            setData(next);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}
