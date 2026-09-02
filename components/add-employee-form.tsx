"use client";

import { useState } from "react";
import { Button } from "./ui";
import { OPERATIONAL_PLACEMENTS } from "@/lib/teams";
import { CONFIGURED_COMPANIES } from "@/lib/company-config";
import { ADDABLE_QUALIFICATION_GROUPS } from "@/lib/skill-groups";

function slugifyPreview(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function AddEmployeeForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [authorizations, setAuthorizations] = useState<string[]>([]);
  const [assignment, setAssignment] = useState<string>("General T1 Pool");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleSkill(skill: string) {
    setSkills((prev) => (prev.includes(skill) ? prev.filter((s) => s !== skill) : [...prev, skill]));
  }

  function toggleAuthorization(company: string) {
    setAuthorizations((prev) => (prev.includes(company) ? prev.filter((c) => c !== company) : [...prev, company]));
  }

  function resetForm() {
    setName("");
    setSkills([]);
    setAuthorizations([]);
    setAssignment("General T1 Pool");
    setError(null);
  }

  async function handleSubmit() {
    setError(null);
    if (!name.trim()) {
      setError("Full name is required.");
      return;
    }
    if (skills.length === 0) {
      setError("Select at least one qualification.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          skills,
          assignment,
          foreign_company_authorizations: authorizations,
          is_duty_officer: assignment === "Duty Officers",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to add employee.");
        return;
      }
      resetForm();
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
    <div className="fixed inset-0 z-40 flex justify-end">
      <div
        className="absolute inset-0 bg-black/20"
        onClick={() => {
          setOpen(false);
          resetForm();
        }}
      />
      <div className="relative w-full sm:max-w-md h-full bg-surface shadow-softer border-l border-border overflow-y-auto p-5 flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-ink">Add Employee</h2>
          <Button
            variant="ghost"
            onClick={() => {
              setOpen(false);
              resetForm();
            }}
          >
            Close
          </Button>
        </div>

        {error && <p className="text-sm text-bad-700 bg-bad-50 rounded-lg px-3 py-2">{error}</p>}

        {/* Section 1 — Employee */}
        <section className="flex flex-col gap-3">
          <h3 className="text-xs uppercase text-muted font-semibold">Employee</h3>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Full name</span>
            <input
              className="border border-border rounded-lg px-3 py-2"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Yasmine Chraibi"
            />
          </label>
          {name.trim() && (
            <p className="text-xs text-muted">
              Employee ID: <span className="font-mono text-ink">{slugifyPreview(name)}</span> (generated from name)
            </p>
          )}
          <p className="text-xs text-muted">Employment: RAM Handling ACE</p>
        </section>

        {/* Section 2 — Operational Placement */}
        <section className="flex flex-col gap-2">
          <h3 className="text-xs uppercase text-muted font-semibold">Operational Placement</h3>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Team / current operational assignment</span>
            <select
              className="border border-border rounded-lg px-3 py-2"
              value={assignment}
              onChange={(e) => setAssignment(e.target.value)}
            >
              {OPERATIONAL_PLACEMENTS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-muted">
            This is who they normally work with for planning — not a shift or a schedule. If a foreign company is
            selected, their roster will follow that company&apos;s real flight schedule once Weekly Planning runs;
            nothing is assigned here yet.
          </p>
        </section>

        {/* Section 3 — Qualifications */}
        <section className="flex flex-col gap-4">
          <h3 className="text-xs uppercase text-muted font-semibold">Qualifications</h3>
          {ADDABLE_QUALIFICATION_GROUPS.map(({ group, skills: groupSkillList }) => (
            <div key={group} className="flex flex-col gap-1.5">
              <span className="text-xs text-muted">{group}</span>
              <div className="flex flex-wrap gap-2">
                {groupSkillList.map((skill) => (
                  <button
                    key={skill}
                    type="button"
                    onClick={() => toggleSkill(skill)}
                    className={`text-xs px-2.5 py-1 rounded-full border ${
                      skills.includes(skill)
                        ? "bg-brand-50 border-brand-500 text-brand-700"
                        : "border-border text-muted"
                    }`}
                  >
                    {skill}
                  </button>
                ))}
              </div>
            </div>
          ))}

          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted">Foreign-company authorizations</span>
            <div className="flex flex-wrap gap-2">
              {CONFIGURED_COMPANIES.map((company) => (
                <button
                  key={company}
                  type="button"
                  onClick={() => toggleAuthorization(company)}
                  className={`text-xs px-2.5 py-1 rounded-full border ${
                    authorizations.includes(company)
                      ? "bg-brand-50 border-brand-500 text-brand-700"
                      : "border-border text-muted"
                  }`}
                >
                  {company}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted">
              Capability, not current placement — an employee can be authorized here while their Operational
              Placement above is still General T1 Pool.
            </p>
          </div>
        </section>

        <div className="flex gap-2 mt-2">
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Adding…" : "Add Employee"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setOpen(false);
              resetForm();
            }}
            disabled={submitting}
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
