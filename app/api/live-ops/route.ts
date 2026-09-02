import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { Employee } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = getSupabaseServerClient();

  const { data: flight, error: flightErr } = await supabase
    .from("flights")
    .select("*")
    .eq("id", "at201")
    .single();
  if (flightErr || !flight) return NextResponse.json({ error: "Flight not found" }, { status: 404 });

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
  const assignedIds = new Set((assignments ?? []).map((a) => a.employee_id));
  const assignedEmployees = (employees as Employee[] | null)?.filter((e) => assignedIds.has(e.id)) ?? [];

  const { data: plannedDuties } = await supabase.from("planned_duties").select("*");

  return NextResponse.json({ flight, assignedEmployees, plannedDuties: plannedDuties ?? [] });
}
