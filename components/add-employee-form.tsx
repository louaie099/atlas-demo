"use client";

import { useState } from "react";
import { Button, Card } from "./ui";

const AVAILABLE_ROLES = [
  "Boarding",
  "Check-in/ACE",
  "Transit",
  "Business Class",
  "Profiling",
  "Care Point",
  "Ramp Team",
  "Duty Officer",
];

export function AddEmployeeForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [roles, setRoles] = useState<string[]>([]);
  const [shiftStart, setShiftStart] = useState("06:00");
  const [shiftEnd, setShiftEnd] = useState("14:00");
  const [rest, setRest] = useState(11);
  const [weeklyHours, setWeeklyHours] = useState(20);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleRole(role: string) {
    setRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));
  }

  async function handleSubmit() {
    setError(null);
    if (!name.trim() || roles.length === 0) {
      setError("Name and at least one role are required.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          roles,
          shift_start: shiftStart,
          shift_end: shiftEnd,
          rest_before_shift_hours: rest,
          weekly_hours: weeklyHours,
          is_duty_officer: roles.includes("Duty Officer"),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to add employee.");
        return;
      }
      setName("");
      setRoles([]);
      onAdded();
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} className="self-start">
        + Add Employee
      </Button>
    );
  }

  return (
    <Card className="flex flex-col gap-4">
      <h3 className="font-semibold text-ink">Add Employee</h3>

      {error && <p className="text-sm text-bad-700 bg-bad-50 rounded-lg px-3 py-2">{error}</p>}

      <div className="grid sm:grid-cols-2 gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Name</span>
          <input
            className="border border-border rounded-lg px-3 py-2"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Yasmine Chraibi"
          />
        </label>

        <div className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Roles</span>
          <div className="flex flex-wrap gap-2">
            {AVAILABLE_ROLES.map((role) => (
              <button
                key={role}
                type="button"
                onClick={() => toggleRole(role)}
                className={`text-xs px-2.5 py-1 rounded-full border ${
                  roles.includes(role)
                    ? "bg-brand-50 border-brand-500 text-brand-700"
                    : "border-border text-muted"
                }`}
              >
                {role}
              </button>
            ))}
          </div>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Shift start</span>
          <input
            type="time"
            className="border border-border rounded-lg px-3 py-2"
            value={shiftStart}
            onChange={(e) => setShiftStart(e.target.value)}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Shift end</span>
          <input
            type="time"
            className="border border-border rounded-lg px-3 py-2"
            value={shiftEnd}
            onChange={(e) => setShiftEnd(e.target.value)}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Rest before shift (hours)</span>
          <input
            type="number"
            className="border border-border rounded-lg px-3 py-2"
            value={rest}
            onChange={(e) => setRest(Number(e.target.value))}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Weekly hours so far</span>
          <input
            type="number"
            className="border border-border rounded-lg px-3 py-2"
            value={weeklyHours}
            onChange={(e) => setWeeklyHours(Number(e.target.value))}
          />
        </label>
      </div>

      <div className="flex gap-2">
        <Button onClick={handleSubmit} disabled={submitting}>
          {submitting ? "Adding…" : "Add Employee"}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
