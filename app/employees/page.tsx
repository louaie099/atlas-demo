"use client";

import { useEffect, useMemo, useState } from "react";
import { Employee } from "@/lib/types";
import { AddEmployeeForm } from "@/components/add-employee-form";
import { WorkforceSummaryLine } from "@/components/employees/workforce-summary-line";
import { EmployeeFilters, EmployeeFilterState } from "@/components/employees/employee-filters";
import { EmployeeTable } from "@/components/employees/employee-table";
import { EmployeeDrawer } from "@/components/employees/employee-drawer";
import { QualificationMatrix } from "@/components/employees/qualification-matrix";

interface EnrichedEmployee extends Employee {
  today: {
    status: "off" | "committed" | "transit" | "on_duty";
    shiftCode: string | null;
    foreignCommitment: { airline: string } | null;
  };
}

type ViewTab = "workforce" | "matrix";

export default function EmployeesPage() {
  const [view, setView] = useState<ViewTab>("workforce");
  const [employees, setEmployees] = useState<EnrichedEmployee[] | null>(null);
  const [demoToday, setDemoToday] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filters, setFilters] = useState<EmployeeFilterState>({
    search: "",
    team: "",
    skill: "",
    shiftToday: "",
    status: "",
  });

  function loadEmployees() {
    fetch("/api/employees")
      .then((r) => r.json())
      .then((data) => {
        setEmployees(data.employees ?? []);
        setDemoToday(data.demoToday ?? "");
      });
  }

  useEffect(loadEmployees, []);

  const allSkills = useMemo(
    () => Array.from(new Set((employees ?? []).flatMap((e) => e.skills))).sort(),
    [employees]
  );

  const filtered = useMemo(() => {
    if (!employees) return [];
    return employees.filter((e) => {
      if (filters.search && !e.name.toLowerCase().includes(filters.search.toLowerCase())) return false;
      // Team filter is flat now — an internal team and a foreign company
      // are selected the same way, matching how the operator actually
      // groups the workforce. No "is this a team or a company" branch.
      if (filters.team && e.assignment !== filters.team) return false;
      if (filters.skill && !e.skills.includes(filters.skill)) return false;
      // Shift Today filters against the employee's ACTUAL daily roster
      // entry for the currently displayed day (e.today.shiftCode), never
      // the static/fallback shift_code field — this is what makes it
      // correct once Weekly Planning lets the operator change which day
      // is "today".
      if (filters.shiftToday) {
        if (filters.shiftToday === "OFF") {
          if (e.today.status !== "off") return false;
        } else if (e.today.shiftCode !== filters.shiftToday) {
          return false;
        }
      }
      if (filters.status && e.today.status !== filters.status) return false;
      return true;
    });
  }, [employees, filters]);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Employees</h1>
        <p className="text-muted mt-1">
          Workforce, qualifications, team assignments and availability
          {demoToday && <> — showing status for {demoToday}</>}
        </p>
      </div>

      <div className="flex gap-1 bg-white border border-border rounded-xl2 p-1 self-start">
        <button
          onClick={() => setView("workforce")}
          className={`px-4 py-1.5 rounded-lg text-sm font-medium ${
            view === "workforce" ? "bg-brand-50 text-brand-700" : "text-muted hover:text-ink"
          }`}
        >
          Employees
        </button>
        <button
          onClick={() => setView("matrix")}
          className={`px-4 py-1.5 rounded-lg text-sm font-medium ${
            view === "matrix" ? "bg-brand-50 text-brand-700" : "text-muted hover:text-ink"
          }`}
        >
          Qualification Matrix
        </button>
      </div>

      {view === "workforce" && (
        <>
          {employees && <WorkforceSummaryLine employees={employees} />}

          <div className="flex flex-wrap items-center justify-between gap-3">
            {employees && <EmployeeFilters filters={filters} onChange={setFilters} allSkills={allSkills} />}
            <AddEmployeeForm onAdded={loadEmployees} />
          </div>

          {employees === null ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : (
            <EmployeeTable employees={filtered} onSelect={setSelectedId} />
          )}
        </>
      )}

      {view === "matrix" && employees && <QualificationMatrix employees={employees} />}

      {selectedId && <EmployeeDrawer employeeId={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  );
}
