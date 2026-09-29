"use client";

import { useState } from "react";
import { ResolvedLaborRules, RuleSeverity } from "@/lib/labor-rules";
import { FatigueConfig, FatigueWeights } from "@/lib/fatigue-config";
import { Badge, Button } from "./ui";
import { RulesResponse } from "./planning-rules-bar";

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
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="number"
      className={inputClass}
      value={value ?? ""}
      placeholder={placeholder ?? "not confirmed"}
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
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof ResolvedLaborRules>(key: K, value: ResolvedLaborRules[K]) => setRules((r) => ({ ...r, [key]: value }));

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/planning/rules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          laborRules: {
            minimumRestHours: rules.minimumRestHours,
            normalWeeklyOffDays: rules.normalWeeklyOffDays,
            normalWeeklyWorkDays: rules.normalWeeklyWorkDays,
            normalOffDaysConsecutive: rules.normalOffDaysConsecutive,
            renfortWeeklyOffDays: rules.renfortWeeklyOffDays,
            maxConsecutiveOffDays: rules.maxConsecutiveOffDays,
            maximumAverageWeeklyWorkingHours: rules.maximumAverageWeeklyWorkingHours,
            workingHoursReferencePeriodDays: rules.workingHoursReferencePeriodDays,
            workingHoursObligationHours: rules.workingHoursObligationHours,
            maxConsecutiveWorkDays: rules.maxConsecutiveWorkDays,
            operationalBufferMinutes: rules.operationalBufferMinutes,
          },
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

        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wide">Weekly roster</h3>
          <RuleRow label="Normal work days per week" severity={sev.normalWeeklyWorkDays}>
            <NumberField value={rules.normalWeeklyWorkDays} onChange={(v) => set("normalWeeklyWorkDays", v ?? rules.normalWeeklyWorkDays)} />
          </RuleRow>
          <RuleRow label="Normal OFF days per week" severity={sev.normalWeeklyOffDays}>
            <NumberField value={rules.normalWeeklyOffDays} onChange={(v) => set("normalWeeklyOffDays", v ?? rules.normalWeeklyOffDays)} />
          </RuleRow>
          <RuleRow
            label="OFF days scheduled consecutively"
            severity={sev.normalOffDaysConsecutive}
            hint="Normal automatic flexible-ACE generation must place the normal OFF pair together (OO WWWWW, W OO WWWW, ...) — it is never silently split just to improve coverage. A genuine shortage that would require splitting surfaces as an honest gap for a human to approve (Find Agent), not an automatic override."
          >
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={rules.normalOffDaysConsecutive}
                onChange={(e) => set("normalOffDaysConsecutive", e.target.checked)}
              />
              {rules.normalOffDaysConsecutive ? "Together" : "May be separated"}
            </label>
          </RuleRow>
          <RuleRow
            label="Max consecutive OFF days"
            severity={sev.maxConsecutiveOffDays}
            hint="A CEILING on how long an OFF run may ever get — a different concept from the recovery-block policy above (that says the normal pair must be together; this says a run must never exceed this many days)."
          >
            <NumberField value={rules.maxConsecutiveOffDays} onChange={(v) => set("maxConsecutiveOffDays", v ?? rules.maxConsecutiveOffDays)} />
          </RuleRow>
          <RuleRow
            label="Weekly planned hours obligation"
            severity={sev.workingHoursObligationHours}
            hint="A different concept from the 42h average ceiling below: how much an employee should be scheduled to work, not a maximum."
          >
            <NumberField value={rules.workingHoursObligationHours} onChange={(v) => set("workingHoursObligationHours", v)} />
          </RuleRow>
        </section>

        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wide">Rest</h3>
          <RuleRow label="Minimum rest between shifts (hours)" severity={sev.minimumRestHours}>
            <NumberField value={rules.minimumRestHours} onChange={(v) => set("minimumRestHours", v ?? rules.minimumRestHours)} />
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
            />
          </RuleRow>
          <RuleRow
            label="Reference period (days)"
            severity={sev.workingHoursReferencePeriodDays}
            hint="Not yet confirmed. Leaving this unset keeps average-hours compliance explicitly not_evaluable, rather than assuming 7/14/28 days."
          >
            <NumberField value={rules.workingHoursReferencePeriodDays} onChange={(v) => set("workingHoursReferencePeriodDays", v)} />
          </RuleRow>
        </section>

        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wide">Consecutive work / recovery</h3>
          <RuleRow
            label="Max consecutive work days"
            severity={sev.maxConsecutiveWorkDays}
            hint="Enforced as a hard engine safety default — but not itself independently confirmed as a separate company-wide rule beyond the normal 5-work/2-off structure above."
          >
            <NumberField value={rules.maxConsecutiveWorkDays} onChange={(v) => set("maxConsecutiveWorkDays", v ?? rules.maxConsecutiveWorkDays)} />
          </RuleRow>
        </section>

        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wide">Operational buffers</h3>
          <RuleRow
            label="Minimum buffer between duties (minutes)"
            severity={sev.operationalBufferMinutes}
            hint="Not yet enforced by generation or validation — representable only, until a real value is confirmed."
          >
            <NumberField value={rules.operationalBufferMinutes} onChange={(v) => set("operationalBufferMinutes", v)} />
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
                  <input type="checkbox" checked={fatigue.enabled} onChange={(e) => setFatigue((f) => ({ ...f, enabled: e.target.checked }))} />
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
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save rules"}
          </Button>
        </div>
      </div>
    </div>
  );
}
