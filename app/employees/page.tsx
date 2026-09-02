"use client";

import { useEffect, useMemo, useState } from "react";
import { Employee } from "@/lib/types";
import { AddEmployeeForm } from "@/components/add-employee-form";
import { WorkforceSummaryLine } from "@/components/employees/workforce-summary-line";
import { EmployeeFilters, EmployeeFilterState } from "@/components/employees/employee-filters";
import { EmployeeTable } from "@/components/employees/employee-table";
import { EmployeeDrawer } from "@/components/employees/employee-drawer";
import { QualificationMatrix } from "@/components/employees/qualification-matrix";
import { CONFIGURED_COMPANIES } from "@/lib/company-config";

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
  const [filters, setFilters] = useState<EmployeeFilterState>({ search: "", team: "", skill: "", status: "" });

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
      if (filters.team) {
        if (filters.team === "__foreign__") {
          if (!CONFIGURED_COMPANIES.includes(e.assignment)) return false;
        } else if (e.assignment !== filters.team) {
          return false;
        }
      }
      if (filters.skill && !e.skills.includes(filters.skill)) return false;
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
