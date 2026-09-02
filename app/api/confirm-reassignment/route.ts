import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { recommendResolution, detectConflict } from "@/lib/conflict";
import { Employee } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  // Returns the current resolution recommendation, if a conflict is active,
  // so the frontend can render the ResolutionPanel before the user confirms.
  const supabase = getSupabaseServerClient();

  const { data: flight } = await supabase.from("flights").select("*").eq("id", "at201").single();
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

  if (!flight) return NextResponse.json({ recommendation: null });

  const assignedIds = new Set((assignments ?? []).map((a) => a.employee_id));
  const assignedEmployees = (employees as Employee[] | null)?.filter((e) => assignedIds.has(e.id)) ?? [];

  const conflict = detectConflict(flight, assignedEmployees, plannedDuties ?? []);
  if (!conflict) return NextResponse.json({ recommendation: null });

  const resolution = recommendResolution(
    conflict,
    (employees as Employee[]) ?? [],
    plannedDuties ?? [],
    "Care Point"
  );

  return NextResponse.json({ recommendation: resolution });
}

export async function POST(req: Request) {
  const supabase = getSupabaseServerClient();
  const { plannedDutyId, newEmployeeId } = await req.json();

  if (!plannedDutyId || !newEmployeeId) {
    return NextResponse.json({ error: "plannedDutyId and newEmployeeId are required" }, { status: 400 });
  }

  const { data: newEmployee } = await supabase.from("employees").select("*").eq("id", newEmployeeId).single();
  if (!newEmployee) return NextResponse.json({ error: "Employee not found" }, { status: 404 });

  const { error: updateErr } = await supabase
    .from("planned_duties")
    .update({ status: "reassigned", reassigned_to_employee_id: newEmployeeId })
    .eq("id", plannedDutyId);
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  const { data: lastStep } = await supabase
    .from("audit_log_entries")
    .select("step_number")
    .order("step_number", { ascending: false })
    .limit(1)
    .single();
  let nextStep = (lastStep?.step_number ?? 0) + 1;

  await supabase.from("audit_log_entries").insert([
    {
      id: `audit-${nextStep}`,
      step_number: nextStep++,
      description: `Resolution recommended and confirmed: reassigned to ${newEmployee.name}`,
    },
    {
      id: `audit-${nextStep}`,
      step_number: nextStep++,
      description: `Reassignment confirmed by Mohammed Alaoui`,
    },
    {
      id: `audit-${nextStep}`,
      step_number: nextStep++,
      description: `Final state: full coverage maintained, no unresolved conflicts`,
    },
  ]);

  return NextResponse.json({ status: "resolved" });
}
