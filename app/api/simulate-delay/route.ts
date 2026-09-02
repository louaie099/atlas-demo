import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { detectConflict } from "@/lib/conflict";
import { Employee } from "@/lib/types";

export const dynamic = "force-dynamic";

function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + minutes;
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export async function POST(req: Request) {
  const supabase = getSupabaseServerClient();
  const { delayMinutes = 45 } = await req.json().catch(() => ({}));

  const { data: flight, error: flightErr } = await supabase
    .from("flights")
    .select("*")
    .eq("id", "at201")
    .single();
  if (flightErr || !flight) return NextResponse.json({ error: "Flight not found" }, { status: 404 });

  const updated = {
    scheduled_departure: addMinutes(flight.scheduled_departure, delayMinutes),
    boarding_window_start: addMinutes(flight.boarding_window_start, delayMinutes),
    boarding_window_end: addMinutes(flight.boarding_window_end, delayMinutes),
    status: "delayed" as const,
  };

  const { error: updateErr } = await supabase.from("flights").update(updated).eq("id", "at201");
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  const { data: requirement } = await supabase
    .from("staffing_requirements")
    .select("*")
    .eq("flight_id", "at201")
    .single();
  const { data: assignments } = await supabase
    .from("assignments")
    .select("employee_id")
    .eq("staffing_requirement_id", requirement?.id ?? "");
  const { data: employees } = await supabase.from("employees").select("*");
  const { data: plannedDuties } = await supabase.from("planned_duties").select("*");

  const assignedIds = new Set((assignments ?? []).map((a) => a.employee_id));
  const assignedEmployees = (employees as Employee[] | null)?.filter((e) => assignedIds.has(e.id)) ?? [];

  const updatedFlight = { ...flight, ...updated };
  const conflict = detectConflict(updatedFlight, assignedEmployees, plannedDuties ?? []);

  const { data: lastStep } = await supabase
    .from("audit_log_entries")
    .select("step_number")
    .order("step_number", { ascending: false })
    .limit(1)
    .single();
  let nextStep = (lastStep?.step_number ?? 0) + 1;

  const newEntries = [
    {
      id: `audit-${nextStep}`,
      step_number: nextStep++,
      description: `Operational event: AT201 delayed ${delayMinutes} min (${flight.scheduled_departure} → ${updated.scheduled_departure})`,
    },
  ];

  if (conflict) {
    newEntries.push({
      id: `audit-${nextStep}`,
      step_number: nextStep++,
      description: `Conflict detected: ${conflict.employee.name} double-booked (AT201 vs. ${conflict.plannedDuty.task})`,
    });
    newEntries.push({
      id: `audit-${nextStep}`,
      step_number: nextStep++,
      description: `Alert raised — ${conflict.overlapMinutes}-minute overlap between AT201 Boarding and ${conflict.plannedDuty.task}`,
    });
  }

  await supabase.from("audit_log_entries").insert(newEntries);

  return NextResponse.json({
    flight: updatedFlight,
    conflict: conflict
      ? {
          employeeName: conflict.employee.name,
          plannedDuty: conflict.plannedDuty,
          overlapMinutes: conflict.overlapMinutes,
        }
      : null,
  });
}
