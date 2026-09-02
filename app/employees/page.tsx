"use client";

import { useEffect, useState } from "react";
import { Employee } from "@/lib/types";
import { Card, Badge } from "@/components/ui";
import { AddEmployeeForm } from "@/components/add-employee-form";

export default function EmployeesPage() {
  const [employees, setEmployees] = useState<Employee[] | null>(null);

  function loadEmployees() {
    fetch("/api/employees")
      .then((r) => r.json())
      .then((data) => setEmployees(data.employees ?? []));
  }

  useEffect(loadEmployees, []);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Employees</h1>
          <p className="text-muted mt-1">
            The underlying facts behind every Atlas recommendation — add staff to extend the
            roster.
          </p>
        </div>
      </div>

      <AddEmployeeForm onAdded={loadEmployees} />

      <Card className="p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-muted border-b border-border">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Roles</th>
              <th className="px-4 py-3">Shift</th>
              <th className="px-4 py-3">Rest</th>
              <th className="px-4 py-3">Weekly Hours</th>
            </tr>
          </thead>
          <tbody>
            {employees?.map((e) => (
              <tr key={e.id} className="border-b border-border last:border-0">
                <td className="px-4 py-3 font-medium text-ink whitespace-nowrap">
                  <div className="flex items-center gap-2">
                    {e.name}
                    {e.is_duty_officer && <Badge tone="brand">Duty Officer</Badge>}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {e.roles.map((r) => (
                      <span key={r} className="text-xs bg-gray-100 text-ink px-2 py-0.5 rounded-full">
                        {r}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-muted">
                  {e.shift_start}–{e.shift_end}
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <Badge tone={e.rest_before_shift_hours >= 10 ? "good" : "bad"}>
                    {e.rest_before_shift_hours}h
                  </Badge>
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <Badge tone={e.weekly_hours >= 35 ? "warn" : "neutral"}>{e.weekly_hours}h</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {employees === null && <p className="text-sm text-muted p-4">Loading…</p>}
      </Card>
    </div>
  );
}
