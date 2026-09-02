import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const supabase = getSupabaseServerClient();
  const { staffingRequirementId, employeeId } = await req.json();

  if (!staffingRequirementId || !employeeId) {
    return NextResponse.json({ error: "staffingRequirementId and employeeId are required" }, { status: 400 });
  }

  const [{ data: requirement }, { data: employee }] = await Promise.all([
    supabase.from("staffing_requirements").select("*").eq("id", staffingRequirementId).single(),
    supabase.from("employees").select("*").eq("id", employeeId).single(),
  ]);

  if (!requirement || !employee) {
    return NextResponse.json({ error: "Requirement or employee not found" }, { status: 404 });
  }

  const { error: insertErr } = await supabase.from("assignments").insert({
    id: `assign-${staffingRequirementId}-${employeeId}`,
    staffing_requirement_id: staffingRequirementId,
    employee_id: employeeId,
  });
  if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });

  const { data: countRows } = await supabase
    .from("assignments")
    .select("id")
    .eq("staffing_requirement_id", staffingRequirementId);
  const coverage = countRows?.length ?? 0;

  const { data: lastStep } = await supabase
    .from("audit_log_entries")
    .select("step_number")
    .order("step_number", { ascending: false })
    .limit(1)
    .single();
  const nextStep = (lastStep?.step_number ?? 0) + 1;

  await supabase.from("audit_log_entries").insert({
    id: `audit-${nextStep}`,
    step_number: nextStep,
    description: `${employee.name} assigned to ${requirement.role} (${requirement.flight_id.toUpperCase()}) by Mohammed Alaoui — coverage ${coverage}/${requirement.total_requirement}`,
  });

  return NextResponse.json({ status: "assigned", coverage, total: requirement.total_requirement });
}
