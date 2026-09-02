import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { scoreCandidates } from "@/lib/scoring";
import { CONFIG } from "@/lib/seed-data";
import { Employee, Assignment } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { requirementId: string } }
) {
  const supabase = getSupabaseServerClient();

  const { data: requirement, error: reqErr } = await supabase
    .from("staffing_requirements")
    .select("*")
    .eq("id", params.requirementId)
    .single();

  if (reqErr || !requirement) {
    return NextResponse.json({ error: "Staffing requirement not found" }, { status: 404 });
  }

  const { data: employees, error: empErr } = await supabase.from("employees").select("*");
  if (empErr) return NextResponse.json({ error: empErr.message }, { status: 500 });

  const { data: assignments, error: assignErr } = await supabase
    .from("assignments")
    .select("*")
    .eq("staffing_requirement_id", requirement.id);
  if (assignErr) return NextResponse.json({ error: assignErr.message }, { status: 500 });

  const alreadyAssignedIds = new Set((assignments as Assignment[]).map((a) => a.employee_id));
  const candidatePool = (employees as Employee[]).filter((e) => !alreadyAssignedIds.has(e.id));

  const windowEnd = requirement.role === "Boarding" ? "14:20" : "08:45"; // approximate check-in window end
  const candidates = scoreCandidates(requirement.role, windowEnd, candidatePool, CONFIG);

  return NextResponse.json({ candidates });
}
