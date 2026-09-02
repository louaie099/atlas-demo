import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
export const dynamic = "force-dynamic";

import { Employee, Flight, StaffingRequirement, Assignment, AgentScheduleEntry } from "@/lib/types";

export async function GET() {
  const supabase = getSupabaseServerClient();

  const [{ data: employees, error: empErr }, { data: assignments, error: assignErr }, { data: requirements, error: reqErr }, { data: flights, error: flightErr }] =
    await Promise.all([
      supabase.from("employees").select("*"),
      supabase.from("assignments").select("*"),
      supabase.from("staffing_requirements").select("*"),
      supabase.from("flights").select("*"),
    ]);

  if (empErr || assignErr || reqErr || flightErr) {
    return NextResponse.json(
      { error: (empErr || assignErr || reqErr || flightErr)?.message },
      { status: 500 }
    );
  }

  const requirementsById = new Map<string, StaffingRequirement>((requirements ?? []).map((r) => [r.id, r]));
  const flightsById = new Map<string, Flight>((flights ?? []).map((f) => [f.id, f]));

  const schedule: AgentScheduleEntry[] = (employees as Employee[])
    .filter((e) => !e.is_duty_officer)
    .map((employee) => {
      const duties = (assignments as Assignment[])
        .filter((a) => a.employee_id === employee.id)
        .map((a) => {
          const requirement = requirementsById.get(a.staffing_requirement_id);
          const flight = requirement ? flightsById.get(requirement.flight_id) : undefined;
          if (!requirement || !flight) return null;
          return {
            flightNumber: flight.flight_number,
            role: requirement.role,
            dayOfWeek: flight.day_of_week,
          };
        })
        .filter((d): d is { flightNumber: string; role: string; dayOfWeek: string } => Boolean(d));

      return {
        employee,
        dayOff: employee.off_days.length > 0,
        duties,
      };
    });

  schedule.sort((a, b) => a.employee.name.localeCompare(b.employee.name));

  return NextResponse.json({ schedule });
}
