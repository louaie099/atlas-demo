import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { Employee, Flight, StaffingRequirement, Assignment, RosterRequirementView } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = getSupabaseServerClient();

  const [{ data: flights, error: flightsErr }, { data: requirements, error: reqErr }, { data: assignments, error: assignErr }, { data: employees, error: empErr }] =
    await Promise.all([
      supabase.from("flights").select("*"),
      supabase.from("staffing_requirements").select("*"),
      supabase.from("assignments").select("*"),
      supabase.from("employees").select("*"),
    ]);

  if (flightsErr || reqErr || assignErr || empErr) {
    return NextResponse.json(
      { error: (flightsErr || reqErr || assignErr || empErr)?.message },
      { status: 500 }
    );
  }

  const flightsById = new Map<string, Flight>((flights ?? []).map((f) => [f.id, f]));
  const employeesById = new Map<string, Employee>((employees ?? []).map((e) => [e.id, e]));

  const views: RosterRequirementView[] = (requirements ?? []).map((req: StaffingRequirement) => {
    const flight = flightsById.get(req.flight_id)!;
    const assignedIds = (assignments ?? [])
      .filter((a: Assignment) => a.staffing_requirement_id === req.id)
      .map((a: Assignment) => a.employee_id);
    const assignedEmployees = assignedIds
      .map((id: string) => employeesById.get(id))
      .filter((e: Employee | undefined): e is Employee => Boolean(e));

    return {
      requirement: req,
      flight,
      assignedEmployees,
      gap: req.total_requirement - assignedEmployees.length,
    };
  });

  return NextResponse.json({ roster: views });
}
