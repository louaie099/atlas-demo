"use client";

import { useEffect, useState } from "react";
import { Employee, AuditLogEntry } from "@/lib/types";
import { Badge, Button } from "@/components/ui";
import { groupSkills } from "@/lib/skill-groups";
import { TeamBadge } from "@/components/team-badge";

interface DayDuty {
  flightNumber: string;
  role: string;
  scheduledDeparture: string;
  airline: string;
}

interface DaySummary {
  dayOfWeek: string;
  shiftCode: string | null;
  status: "off" | "committed" | "transit" | "on_duty";
  duties: DayDuty[];
  foreignCommitment: { airline: string; window: { start: string; end: string } } | null;
}

type Tab = "overview" | "qualifications" | "schedule" | "history";

const statusLabel: Record<string, string> = {
  on_duty: "On Duty",
  off: "Off",
  transit: "Transit",
  committed: "Committed",
};

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/** Simple horizontal bar: full shift span, with the protected window (if any) highlighted proportionally. */
function DayTimelineBar({ day }: { day: DaySummary }) {
  if (!day.shiftCode && day.status !== "committed") return null;

  // Use a fixed 24h scale (0-1440 minutes) for simplicity and honesty —
  // we don't always have exact shift bounds for every rendered day.
  const dayStartMin = 0;
  const dayEndMin = 1440;
  const pct = (mins: number) => ((mins - dayStartMin) / (dayEndMin - dayStartMin)) * 100;

  return (
    <div className="mt-2">
      <div className="relative h-6 bg-gray-100 rounded-full overflow-hidden">
        {day.foreignCommitment && (
          <div
            className="absolute top-0 bottom-0 bg-warn-500/70"
            style={{
              left: `${pct(timeToMinutes(day.foreignCommitment.window.start))}%`,
              width: `${pct(timeToMinutes(day.foreignCommitment.window.end)) - pct(timeToMinutes(day.foreignCommitment.window.start))}%`,
            }}
            title={`${day.foreignCommitment.airline} protected window: ${day.foreignCommitment.window.start}–${day.foreignCommitment.window.end}`}
          />
        )}
      </div>
      {day.foreignCommitment && (
        <p className="text-xs text-muted mt-1">
          La RAM / T1 → <span className="text-warn-700 font-medium">{day.foreignCommitment.airline} protected window ({day.foreignCommitment.window.start}–{day.foreignCommitment.window.end}) / T2</span> → La RAM / T1
        </p>
      )}
    </div>
  );
}

export function EmployeeDrawer({ employeeId, onClose }: { employeeId: string; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [weeklySchedule, setWeeklySchedule] = useState<DaySummary[] | null>(null);
  const [history, setHistory] = useState<AuditLogEntry[] | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/employees/${employeeId}`)
      .then((r) => r.json())
      .then((data) => {
        setEmployee(data.employee);
        setWeeklySchedule(data.weeklySchedule ?? []);
        setHistory(data.history ?? []);
        setSelectedDay(data.weeklySchedule?.[0]?.dayOfWeek ?? null);
      });
  }, [employeeId]);

  const selectedDaySummary = weeklySchedule?.find((d) => d.dayOfWeek === selectedDay);

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-full sm:max-w-lg h-full bg-surface shadow-softer border-l border-border overflow-y-auto p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-ink">{employee?.name ?? "Loading…"}</h2>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>

        {employee && (
          <>
            <div className="flex gap-1 bg-white border border-border rounded-xl2 p-1 self-start flex-wrap">
              {(["overview", "qualifications", "schedule", "history"] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-3 py-1 rounded-lg text-xs font-medium capitalize ${
                    tab === t ? "bg-brand-50 text-brand-700" : "text-muted hover:text-ink"
                  }`}
                >
                  {t === "schedule" ? "Weekly Schedule" : t}
                </button>
              ))}
            </div>

            {tab === "overview" && (
              <div className="flex flex-col gap-3 text-sm">
                <Row label="Employee ID" value={employee.id} />
                <Row label="Employer" value="RAM Handling ACE" />
                <Row label="Default Team" value={<TeamBadge name={employee.assignment} />} />
                <Row label="Current Shift" value={employee.shift_code ?? `${employee.shift_start}–${employee.shift_end} (custom)`} />
                <Row label="Working Hours Today" value={`${employee.shift_start}–${employee.shift_end}`} />
                <Row
                  label="Current Status"
                  value={
                    <Badge tone={employee.assignment === "Transit" ? "warn" : "good"}>
                      {employee.is_duty_officer ? "Duty Officer (fixed planning)" : "Available per assignment"}
                    </Badge>
                  }
                />
                <Row label="Weekly Hours" value={`${employee.weekly_hours}h`} />
                <Row label="Rest Before Shift" value={`${employee.rest_before_shift_hours}h`} />
                {employee.foreign_company_authorizations.length > 0 && (
                  <Row label="Foreign Authorizations" value={employee.foreign_company_authorizations.join(", ")} />
                )}
              </div>
            )}

            {tab === "qualifications" && (
              <div className="flex flex-col gap-4">
                {groupSkills(employee.skills).map(({ group, skills }) => (
                  <div key={group}>
                    <p className="text-xs uppercase text-muted mb-1">{group}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {skills.map((s) => (
                        <span key={s} className="text-xs bg-gray-100 text-ink px-2.5 py-1 rounded-full">
                          {s}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
                {employee.foreign_company_authorizations.length > 0 && (
                  <div>
                    <p className="text-xs uppercase text-muted mb-1">Foreign-company authorizations</p>
                    <div className="flex flex-wrap gap-1.5">
                      {employee.foreign_company_authorizations.map((c) => (
                        <span key={c} className="text-xs bg-brand-50 text-brand-700 px-2.5 py-1 rounded-full">
                          {c}
                        </span>
                      ))}
                    </div>
                    <p className="text-xs text-muted mt-1">
                      Authorization is capability, not current placement — see Assignment on the Overview tab.
                    </p>
                  </div>
                )}
              </div>
            )}

            {tab === "schedule" && weeklySchedule && (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-7 gap-1 text-center text-xs">
                  {weeklySchedule.map((d) => (
                    <button
                      key={d.dayOfWeek}
                      onClick={() => setSelectedDay(d.dayOfWeek)}
                      className={`rounded-lg px-1 py-2 border ${
                        selectedDay === d.dayOfWeek ? "border-brand-500 bg-brand-50" : "border-border"
                      }`}
                    >
                      <div className="font-medium text-ink">{d.dayOfWeek.slice(0, 3)}</div>
                      <div className="text-muted">{d.shiftCode ?? "OFF"}</div>
                      <div className="text-muted">{d.duties.length || "—"}</div>
                    </button>
                  ))}
                </div>

                {selectedDaySummary && (
                  <div className="border border-border rounded-xl2 p-3 flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-ink">{selectedDaySummary.dayOfWeek}</span>
                      <Badge tone={selectedDaySummary.status === "off" ? "neutral" : "good"}>
                        {statusLabel[selectedDaySummary.status]}
                      </Badge>
                    </div>

                    {selectedDaySummary.status === "off" ? (
                      <p className="text-sm text-muted">Off — no shift scheduled.</p>
                    ) : (
                      <>
                        <p className="text-sm text-muted">
                          Shift start ({employee.shift_start}) → {selectedDaySummary.duties.length === 0 ? "no duties assigned yet" : ""}
                        </p>
                        {selectedDaySummary.duties.map((duty, i) => (
                          <p key={i} className="text-sm text-ink">
                            → {duty.scheduledDeparture} {duty.flightNumber} ({duty.airline}) · {duty.role}
                          </p>
                        ))}
                        <p className="text-sm text-muted">→ Shift end ({employee.shift_end})</p>
                        <DayTimelineBar day={selectedDaySummary} />
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {tab === "history" && (
              <div className="flex flex-col gap-2">
                {history && history.length === 0 && (
                  <p className="text-sm text-muted">No audit entries mention this employee yet.</p>
                )}
                {history?.map((h) => (
                  <div key={h.id} className="text-sm border-b border-border pb-2">
                    <span className="text-xs text-muted">Step {h.step_number}</span>
                    <p className="text-ink">{h.description}</p>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border pb-2">
      <span className="text-muted">{label}</span>
      <span className="text-ink font-medium">{value}</span>
    </div>
  );
}
