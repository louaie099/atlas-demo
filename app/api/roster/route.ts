import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
export const dynamic = "force-dynamic";

import {
  Employee,
  Flight,
  StaffingRequirement,
  Assignment,
  RosterRequirementView,
  RequirementCoverageStatus,
} from "@/lib/types";

function computeCoverageStatus(
  requirement: StaffingRequirement,
  gap: number
): RequirementCoverageStatus {
  if (requirement.needs_configuration) return "needs_configuration";
  if (gap > 0) return "gap";
  return "covered";
  // "conflict" is computed at the Live Operations layer (see
  // /api/simulate-delay) once an operational event actually creates one —
  // it never applies to a static, undisturbed weekly plan.
}

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

    const gap = req.needs_configuration ? 0 : req.total_requirement - assignedEmployees.length;

    return {
      requirement: req,
      flight,
      assignedEmployees,
      gap,
      coverageStatus: computeCoverageStatus(req, gap),
    };
  });

  // Sort by day then departure time so Flight Coverage reads as a real schedule.
  views.sort((a, b) => {
    if (a.flight.day_of_week !== b.flight.day_of_week) {
      return a.flight.day_of_week.localeCompare(b.flight.day_of_week);
    }
    return a.flight.scheduled_departure.localeCompare(b.flight.scheduled_departure);
  });

  return NextResponse.json({ roster: views });
}
