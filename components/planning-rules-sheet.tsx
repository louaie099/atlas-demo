"use client";

import { useState } from "react";
import { ResolvedLaborRules, RuleSeverity } from "@/lib/labor-rules";
import { FatigueConfig, FatigueWeights } from "@/lib/fatigue-config";
import { BreakPolicy } from "@/lib/break-policy";
import { Badge, Button } from "./ui";
import { RulesResponse } from "./planning-rules-bar";
import { useRole } from "./role-context";
import { ROLE_HEADER, canManageLaborRules } from "@/lib/roles";

const inputClass = "border border-border rounded-lg px-3 py-2 w-28 text-sm";

function severityBadge(severity: RuleSeverity | undefined) {
  if (severity === "hard") return <Badge tone="bad">HARD</Badge>;
  if (severity === "soft") return <Badge tone="brand">SOFT</Badge>;
  if (severity === "recommendation") return <Badge tone="warn">RECOMMENDATION</Badge>;
  return <Badge tone="neutral">NOT EVALUABLE</Badge>;
}

/** A labeled row: name + severity badge on the left, an editable (or disabled/"not confirmed") control on the right. */
function RuleRow({
  label,
  severity,
  hint,
  children,
}: {
  label: string;
  severity?: RuleSeverity;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div>
        <p className="text-sm text-ink">{label}</p>
        {hint && <p className="text-xs text-muted mt-0.5 max-w-sm">{hint}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {severity && severityBadge(severity)}
        {children}
      </div>
    </div>
  );
}

/** Number input bound to an editable rule value; `null` renders a "not confirmed" placeholder input instead of guessing a number. */
function NumberField({
  value,
  onChange,
  placeholder,
  disabled,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <input
      type="number"
      className={inputClass}
      value={value ?? ""}
      placeholder={placeholder ?? "not confirmed"}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
    />
  );
}

const FATIGUE_WEIGHT_LABELS: { key: keyof FatigueWeights; label: string }[] = [
  { key: "durationWeight", label: "Duration burden" },
  { key: "earlyStartWeight", label: "Very-early-start burden" },
  { key: "nightWorkWeight", label: "Night-work burden" },
  { key: "lateFinishWeight", label: "Late-finish burden" },
  { key: "transitionWeight", label: "Shift-transition burden" },
  { key: "consecutiveDifficultShiftWeight", label: "Consecutive-difficult-shift accumulation" },
  { key: "recoveryWeight", label: "Recovery effect" },
  { key: "transportBurdenWeight", label: "Transport burden (if/when confirmed)" },
];

/**
 * The full Planning Rules editor -- a slide-over drawer (same mechanics as
 * find-agent-sheet.tsx), opened from PlanningRulesBar's "Edit rules"
 * action. Sections follow "common rules first, advanced progressively
 * disclosed": Weekly roster / Rest / Working-hours limit / Consecutive
 * work-recovery / Operational buffers / Team & rotation policy are always
 * visible; Fatigue is collapsed behind "Show advanced" by default.
 *
 * Saving PUTs the edited subset to /api/planning/rules, which persists a
 * NEW effective-dated labor-rule row (lib/planning/rules-service.ts's
 * saveLaborRuleEdit -- never an in-place mutation, so an already-generated
 * plan's own config_snapshot is untouched) and/or overwrites the current
 * fatigue config. This never triggers Make Planning itself -- only the
 * NEXT Make Planning/Regenerate picks up the change; an existing draft
 * will show its usual "schedule changed, click Make Planning" staleness
 * banner once its resolved config differs from what it was generated
 * under (the existing hashPlanInputs mechanism, unchanged).
 */
export function PlanningRulesSheet({
  data,
  onClose,
  onSaved,
}: {
  data: RulesResponse;
  onClose: () => void;
  onSaved: (next: RulesResponse) => void;
}) {
  const [rules, setRules] = useState<ResolvedLaborRules>(data.resolved);
  const [fatigue, setFatigue] = useState<FatigueConfig>(data.fatigue);
  const [breakPolicy, setBreakPolicy] = useState<BreakPolicy>(data.resolved.breakPolicy);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // LABOR RULES v2 (2026-10-20) -- Administrator-only edit boundary (see
  // lib/roles.ts's canManageLaborRules doc comment and Moses's explicit
  // "appear to the planner... configured by the admins" direction).
  // Planners still see every value above (the drawer itself stays open to
  // them) -- only the controls are disabled, exactly like
  // employee-drawer.tsx's existing canManageEmployees pattern.
  const { role } = useRole();
  const allowed = canManageLaborRules(role);

  const set = <K extends keyof ResolvedLaborRules>(key: K, value: ResolvedLaborRules[K]) => setRules((r) => ({ ...r, [key]: value }));

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/planning/rules", {
        method: "PUT",
        headers: { "Content-Type": "application/json", [ROLE_HEADER]: role },
        body: JSON.stringify({
          laborRules: {
            minimumRestHours: rules.minimumRestHours,
            normalWeeklyOffDays: rules.normalWeeklyOffDays,
            normalWeeklyWorkDays: rules.normalWeeklyWorkDays,
            normalOffDaysConsecutive: rules.normalOffDaysConsecutive,
            minimumOffDaysPerPlanningWeek: rules.minimumOffDaysPerPlanningWeek,
            renfortWeeklyOffDays: rules.renfortWeeklyOffDays,
            maxConsecutiveOffDays: rules.maxConsecutiveOffDays,
            maximumAverageWeeklyWorkingHours: rules.maximumAverageWeeklyWorkingHours,
            workingHoursReferencePeriodDays: rules.workingHoursReferencePeriodDays,
            workingHoursObligationHours: rules.workingHoursObligationHours,
            maxConsecutiveWorkDays: rules.maxConsecutiveWorkDays,
            operationalBufferMinutes: rules.operationalBufferMinutes,
            // LABOR RULES v2 fields.
            minimumWeeklyPaidHours: rules.minimumWeeklyPaidHours,
            maximumWeeklyPaidHours: rules.maximumWeeklyPaidHours,
            minimumMonthlyPaidHours: rules.minimumMonthlyPaidHours,
            maximumMonthlyPaidHours: rules.maximumMonthlyPaidHours,
            maxContinuousShiftHours: rules.maxContinuousShiftHours,
            maxConsecutiveNightShifts: rules.maxConsecutiveNightShifts,
            maxRestIntervalHours: rules.maxRestIntervalHours,
          },
          breakPolicy,
          fatigue,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Could not save — please try again.");
        return;
      }
      onSaved({ resolved: json.resolved, severity: json.severity, fatigue: json.fatigue });
    } catch {
      setError("Could not reach the server — nothing was saved.");
    } finally {
      setSaving(false);
    }
  }

  const sev = data.severity;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-full sm:max-w-lg h-full bg-surface shadow-softer border-l border-border overflow-y-auto p-5 flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-ink">Planning Rules</h2>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        <p className="text-xs text-muted -mt-3">
          Confirmed operational/labor rules below drive what ATLAS actually generates. A HARD rule is never softened by
          editing it here — the number changes, the enforcement does not.
        </p>

        {error && <p className="text-sm text-bad-700 bg-bad-50 border border-bad-500/30 rounded-lg px-3 py-2">{error}</p>}

        {!allowed && (
          <p className="text-xs text-muted bg-surface-muted border border-border rounded-lg px-3 py-2">
            You can view every rule below, but only an Administrator can change them.
          </p>
        )}

        {(data.configurationIssues?.length ?? 0) > 0 && (
          <div className="text-xs text-bad-700 bg-bad-50 border border-bad-500/30 rounded-lg px-3 py-2 flex flex-col gap-1">
            <p className="font-semibold">Configuration conflict{(data.configurationIssues?.length ?? 0) > 1 ? "s" : ""} — these values cannot all be satisfied:</p>
            {data.configurationIssues!.map((issue) => (
              <p key={issue.requirementId}>{issue.description}</p>
            ))}
          </div>
        )}

        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wide">Weekly roster</h3>
          <RuleRow label="Normal work days per week" severity={sev.normalWeeklyWorkDays}>
            <NumberField
              value={rules.normalWeeklyWorkDays}
              onChange={(v) => set("normalWeeklyWorkDays", v ?? rules.normalWeeklyWorkDays)}
              disabled={!allowed}
            />
          </RuleRow>
          <RuleRow
            label="Minimum OFF days per planning week"
            severity={sev.minimumOffDaysPerPlanningWeek}
            hint="A FLOOR: how many OFF days must be granted, at minimum, in every Monday-Sunday planning week. Applies to the flexible pool, Profiling, Mesure and foreign-company teams (not the fixed JR → NT → OFF → OFF cycle). A week below it is flagged as a hard violation."
          >
            <NumberField
              value={rules.minimumOffDaysPerPlanningWeek}
              onChange={(v) => set("minimumOffDaysPerPlanningWeek", v ?? rules.minimumOffDaysPerPlanningWeek)}
              disabled={!allowed}
            />
          </RuleRow>
          <RuleRow
            label="Normal OFF days per week"
            severity={sev.normalWeeklyOffDays}
            hint="The normal TARGET when there is no shortage — usually equal to or above the minimum above, never the floor itself."
          >
            <NumberField
              value={rules.normalWeeklyOffDays}
              onChange={(v) => set("normalWeeklyOffDays", v ?? rules.normalWeeklyOffDays)}
              disabled={!allowed}
            />
          </RuleRow>
          <RuleRow
            label="OFF days scheduled consecutively"
            severity={sev.normalOffDaysConsecutive}
            hint="Whether this week's OFF days (however many — never fewer than the minimum) must form ONE consecutive block (OO WWWWW, W OO WWWW, ...). They are never silently split, and never cut below the minimum, just to improve coverage. A genuine shortage that would require either surfaces as an honest gap for a human to approve (Find Agent), not an automatic override."
          >
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={rules.normalOffDaysConsecutive}
                onChange={(e) => set("normalOffDaysConsecutive", e.target.checked)}
                disabled={!allowed}
              />
              {rules.normalOffDaysConsecutive ? "Together" : "May be separated"}
            </label>
          </RuleRow>
          <RuleRow
            label="Max consecutive OFF days"
            severity={sev.maxConsecutiveOffDays}
            hint="A CEILING on how long an OFF run may ever get — a different concept from the recovery-block policy above (that says the normal pair must be together; this says a run must never exceed this many days)."
          >
            <NumberField
              value={rules.maxConsecutiveOffDays}
              onChange={(v) => set("maxConsecutiveOffDays", v ?? rules.maxConsecutiveOffDays)}
              disabled={!allowed}
            />
          </RuleRow>
          <RuleRow
            label="Weekly planned hours obligation"
            severity={sev.workingHoursObligationHours}
            hint="A different concept from the 42h average ceiling below: how much an employee should be scheduled to work, not a maximum."
          >
            <NumberField value={rules.workingHoursObligationHours} onChange={(v) => set("workingHoursObligationHours", v)} disabled={!allowed} />
          </RuleRow>
        </section>

        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wide">Rest</h3>
          <RuleRow label="Minimum rest between shifts (hours)" severity={sev.minimumRestHours}>
            <NumberField value={rules.minimumRestHours} onChange={(v) => set("minimumRestHours", v ?? rules.minimumRestHours)} disabled={!allowed} />
          </RuleRow>
          <RuleRow
            label="Maximum rest interval (hours)"
            severity={sev.maxRestIntervalHours}
            hint="A soft TARGET only — no confirmed policy says an employee can be rested 'too much'. Leaving this unset (not confirmed) keeps it fully disabled; it has no engine enforcement point today even when set."
          >
            <NumberField value={rules.maxRestIntervalHours} onChange={(v) => set("maxRestIntervalHours", v)} disabled={!allowed} />
          </RuleRow>
        </section>

        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wide">Working-hours limit</h3>
          <RuleRow
            label="Maximum average weekly working hours"
            severity={sev.maximumAverageWeeklyWorkingHours}
            hint="Confirmed as an AVERAGE over a reference period — NOT a Monday-Sunday ceiling. Compliance stays not-evaluable until the reference period below is confirmed."
          >
            <NumberField
              value={rules.maximumAverageWeeklyWorkingHours}
              onChange={(v) => set("maximumAverageWeeklyWorkingHours", v ?? rules.maximumAverageWeeklyWorkingHours)}
              disabled={!allowed}
            />
          </RuleRow>
          <RuleRow
            label="Reference period (days)"
            severity={sev.workingHoursReferencePeriodDays}
            hint="Not yet confirmed. Leaving this unset keeps average-hours compliance explicitly not_evaluable, rather than assuming 7/14/28 days."
          >
            <NumberField
              value={rules.workingHoursReferencePeriodDays}
              onChange={(v) => set("workingHoursReferencePeriodDays", v)}
              disabled={!allowed}
            />
          </RuleRow>
        </section>

        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wide">Paid-hour limits (weekly &amp; monthly)</h3>
          <p className="text-xs text-muted -mt-0.5 max-w-sm">
            Direct ceilings/floors on PAID hours (scheduled span minus any configured unpaid break — see Break policy
            below), evaluated against one real week's or calendar month's own data — no reference period needed, a
            genuinely different mechanism from the average-hours rule above. Unset = not configured, never evaluated.
          </p>
          <RuleRow label="Minimum weekly paid hours" severity={sev.minimumWeeklyPaidHours}>
            <NumberField value={rules.minimumWeeklyPaidHours} onChange={(v) => set("minimumWeeklyPaidHours", v)} disabled={!allowed} />
          </RuleRow>
          <RuleRow label="Maximum weekly paid hours" severity={sev.maximumWeeklyPaidHours}>
            <NumberField value={rules.maximumWeeklyPaidHours} onChange={(v) => set("maximumWeeklyPaidHours", v)} disabled={!allowed} />
          </RuleRow>
          <RuleRow
            label="Minimum monthly paid hours"
            severity={sev.minimumMonthlyPaidHours}
            hint="Only ever evaluated once the calendar month has full weekly-plan coverage — never emitted against an incomplete month."
          >
            <NumberField value={rules.minimumMonthlyPaidHours} onChange={(v) => set("minimumMonthlyPaidHours", v)} disabled={!allowed} />
          </RuleRow>
          <RuleRow label="Maximum monthly paid hours" severity={sev.maximumMonthlyPaidHours}>
            <NumberField value={rules.maximumMonthlyPaidHours} onChange={(v) => set("maximumMonthlyPaidHours", v)} disabled={!allowed} />
          </RuleRow>
        </section>

        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wide">Consecutive work / recovery</h3>
          <RuleRow
            label="Max consecutive work days"
            severity={sev.maxConsecutiveWorkDays}
            hint="Enforced as a hard engine safety default — but not itself independently confirmed as a separate company-wide rule beyond the normal 5-work/2-off structure above."
          >
            <NumberField
              value={rules.maxConsecutiveWorkDays}
              onChange={(v) => set("maxConsecutiveWorkDays", v ?? rules.maxConsecutiveWorkDays)}
              disabled={!allowed}
            />
          </RuleRow>
          <RuleRow
            label="Max continuous shift duration (hours)"
            severity={sev.maxContinuousShiftHours}
            hint="A ceiling on ONE shift's own scheduled span (never paid hours — a break does not shorten how long someone is actually on shift). Enforced today only as a Stage 6 (flexible General T1 pool) pre-scoring filter, plus a plan-level validation backstop for every population."
          >
            <NumberField value={rules.maxContinuousShiftHours} onChange={(v) => set("maxContinuousShiftHours", v)} disabled={!allowed} />
          </RuleRow>
          <RuleRow
            label="Max consecutive night shifts"
            severity={sev.maxConsecutiveNightShifts}
            hint="A ceiling on consecutive calendar NIGHT shifts (reusing the existing fatigue-model night window), counted continuously across week boundaries. Same enforcement scope as the shift-duration ceiling above."
          >
            <NumberField value={rules.maxConsecutiveNightShifts} onChange={(v) => set("maxConsecutiveNightShifts", v)} disabled={!allowed} />
          </RuleRow>
        </section>

        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wide">Break policy</h3>
          <p className="text-xs text-muted -mt-0.5 max-w-sm">
            Scheduled span (raw shift duration) and PAID hours are tracked separately (see docs/known-limitations/labor-
            rules-v2.md). Disabled (the default) makes paid hours exactly equal scheduled span — a genuine no-op, never
            a guessed deduction.
          </p>
          <RuleRow label="Deduct an unpaid break from paid hours" severity={breakPolicy.enabled ? "hard" : "not_evaluable"}>
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={breakPolicy.enabled}
                onChange={(e) => setBreakPolicy((p) => ({ ...p, enabled: e.target.checked }))}
                disabled={!allowed}
              />
              {breakPolicy.enabled ? "On" : "Off"}
            </label>
          </RuleRow>
          <RuleRow label="Unpaid break per qualifying shift (minutes)" hint="null = not configured.">
            <NumberField
              value={breakPolicy.unpaidBreakMinutesPerShift}
              onChange={(v) => setBreakPolicy((p) => ({ ...p, unpaidBreakMinutesPerShift: v }))}
              disabled={!allowed}
            />
          </RuleRow>
          <RuleRow
            label="Minimum shift length to qualify (hours)"
            hint="null = applies to every shift (when the deduction above is on)."
          >
            <NumberField
              value={breakPolicy.minimumShiftHoursForBreak}
              onChange={(v) => setBreakPolicy((p) => ({ ...p, minimumShiftHoursForBreak: v }))}
              disabled={!allowed}
            />
          </RuleRow>
        </section>

        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wide">Operational buffers</h3>
          <RuleRow
            label="Minimum buffer between duties (minutes)"
            severity={sev.operationalBufferMinutes}
            hint="Not yet enforced by generation or validation — representable only, until a real value is confirmed."
          >
            <NumberField value={rules.operationalBufferMinutes} onChange={(v) => set("operationalBufferMinutes", v)} disabled={!allowed} />
          </RuleRow>
        </section>

        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wide">Team &amp; rotation policy</h3>
          <p className="text-xs text-muted">
            Not every population follows the same rotation — each is generated under its own real mechanism, shown here for
            visibility only (not editable):
          </p>
          <ul className="text-xs text-muted list-disc list-inside flex flex-col gap-0.5">
            <li>Flexible General T1 pool — demand-driven, 5 work / 2 OFF target</li>
            <li>Profiling &amp; Mesure — demand-driven, cap-paced rest when capacity is tight</li>
            <li>Foreign-company teams — driven by each company's real flight schedule, plus a normal-roster top-up</li>
            <li>Transit, Leaders, Duty Officers — fixed JR → NT → OFF → OFF cycle, exempt from the hard caps above</li>
          </ul>
        </section>

        <section className="flex flex-col gap-1.5 border-t border-border pt-3">
          <button className="text-xs font-semibold text-muted uppercase tracking-wide text-left" onClick={() => setShowAdvanced((s) => !s)}>
            {showAdvanced ? "▾" : "▸"} Advanced — Fatigue (prototype, unconfirmed)
          </button>
          {showAdvanced && (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-muted max-w-sm">
                Every coefficient below is an engineering placeholder describing operational workload-burden PATTERNS only —
                not a validated fatigue model, not confirmed by RAM Handling, and never a measure of fitness for duty.
              </p>
              <RuleRow label="Fatigue optimization" severity="soft">
                <label className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={fatigue.enabled}
                    onChange={(e) => setFatigue((f) => ({ ...f, enabled: e.target.checked }))}
                    disabled={!allowed}
                  />
                  {fatigue.enabled ? "On" : "Off"}
                </label>
              </RuleRow>
              {FATIGUE_WEIGHT_LABELS.map(({ key, label }) => (
                <RuleRow key={key} label={label}>
                  <input
                    type="number"
                    step="0.05"
                    className={inputClass}
                    value={fatigue.weights[key]}
                    onChange={(e) => setFatigue((f) => ({ ...f, weights: { ...f.weights, [key]: Number(e.target.value) } }))}
                    disabled={!allowed}
                  />
                </RuleRow>
              ))}
            </div>
          )}
        </section>

        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !allowed}>
            {saving ? "Saving…" : "Save rules"}
          </Button>
        </div>
      </div>
    </div>
  );
}
