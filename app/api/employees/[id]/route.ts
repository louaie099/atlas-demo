import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { computeEmployeeDaySummary } from "@/lib/employee-status";
import { DAYS_WITH_DATA } from "@/lib/seed-data";
import { Employee, Assignment, StaffingRequirement, Flight, AuditLogEntry } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const supabase = getSupabaseServerClient();

  const [
    { data: employee, error: empErr },
    { data: assignments, error: assignErr },
    { data: requirements, error: reqErr },
    { data: flights, error: flightErr },
    { data: auditEntries, error: auditErr },
  ] = await Promise.all([
    supabase.from("employees").select("*").eq("id", params.id).single(),
    supabase.from("assignments").select("*"),
    supabase.from("staffing_requirements").select("*"),
    supabase.from("flights").select("*"),
    supabase.from("audit_log_entries").select("*").order("step_number", { ascending: true }),
  ]);

  if (empErr || !employee) return NextResponse.json({ error: "Employee not found" }, { status: 404 });
  if (assignErr || reqErr || flightErr || auditErr) {
    return NextResponse.json({ error: (assignErr || reqErr || flightErr || auditErr)?.message }, { status: 500 });
  }

  const emp = employee as Employee;

  const weeklySchedule = DAYS_WITH_DATA.map((day) =>
    computeEmployeeDaySummary(emp, day, assignments as Assignment[], requirements as StaffingRequirement[], flights as Flight[])
  );

  // "History" here means audit entries whose description mentions this
  // employee by name — a defensible reuse of existing data, not a new
  // per-employee history table. Not exhaustive or guaranteed complete,
  // but genuine (never fabricated entries).
  const history = (auditEntries as AuditLogEntry[]).filter((entry) => entry.description.includes(emp.name));

  return NextResponse.json({ employee: emp, weeklySchedule, history });
}
