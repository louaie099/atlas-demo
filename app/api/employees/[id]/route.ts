import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { computeEmployeeDaySummary } from "@/lib/employee-status";
import { DAYS_WITH_DATA } from "@/lib/seed-data";
import { Employee, Assignment, StaffingRequirement, Flight, AuditLogEntry } from "@/lib/types";
import { ROLE_HEADER, getRoleFromHeader, canManageEmployees } from "@/lib/roles";

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

/**
 * Edits an employee's WORKFORCE PROFILE — name, assignment, skills,
 * foreign-company authorizations, active status. Never touches
 * shift_start/shift_end/rest_before_shift_hours/weekly_hours — those stay
 * Weekly Planning's responsibility, in this route as much as in creation.
 *
 * PERMISSION ENFORCEMENT: Administrator only, checked server-side (see
 * POST /api/employees for the same pattern and rationale).
 *
 * AUDIT: writes one entry per "important" change — assignment change,
 * any qualification removed, any foreign-company authorization change,
 * or active/inactive toggling — attributed to the role that made it
 * (there is no real user identity in this demo; see lib/roles.ts).
 * Cosmetic changes (e.g. adding a new qualification without removing
 * anything) are saved but not separately audited, matching what was
 * asked for.
 */
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const role = getRoleFromHeader(req.headers.get(ROLE_HEADER));
  if (!canManageEmployees(role)) {
    return NextResponse.json(
      { error: "Administrator permission required to edit employees." },
      { status: 403 }
    );
  }

  const supabase = getSupabaseServerClient();
  const body = await req.json();

  const { data: before, error: fetchErr } = await supabase
    .from("employees")
    .select("*")
    .eq("id", params.id)
    .single();
  if (fetchErr || !before) return NextResponse.json({ error: "Employee not found" }, { status: 404 });

  const beforeEmp = before as Employee;

  const updates: Partial<Employee> = {};
  if (typeof body.name === "string" && body.name.trim()) updates.name = body.name;
  if (Array.isArray(body.skills)) updates.skills = body.skills;
  if (typeof body.assignment === "string") updates.assignment = body.assignment;
  if (Array.isArray(body.foreign_company_authorizations)) updates.foreign_company_authorizations = body.foreign_company_authorizations;
  if (typeof body.active === "boolean") updates.active = body.active;
  if (typeof body.is_duty_officer === "boolean") updates.is_duty_officer = body.is_duty_officer;

  const { data: after, error: updateErr } = await supabase
    .from("employees")
    .update(updates)
    .eq("id", params.id)
    .select()
    .single();
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  const afterEmp = after as Employee;
  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);

  const auditDescriptions: string[] = [];

  if (updates.assignment !== undefined && updates.assignment !== beforeEmp.assignment) {
    auditDescriptions.push(
      `${afterEmp.name}'s operational assignment changed from ${beforeEmp.assignment} to ${afterEmp.assignment} by ${roleLabel}`
    );
  }

  if (updates.skills !== undefined) {
    const removed = beforeEmp.skills.filter((s) => !afterEmp.skills.includes(s));
    if (removed.length > 0) {
      auditDescriptions.push(
        `Qualification(s) removed for ${afterEmp.name}: ${removed.join(", ")} — by ${roleLabel}`
      );
    }
  }

  if (updates.foreign_company_authorizations !== undefined) {
    const beforeAuth = beforeEmp.foreign_company_authorizations;
    const afterAuth = afterEmp.foreign_company_authorizations;
    const added = afterAuth.filter((c) => !beforeAuth.includes(c));
    const removed = beforeAuth.filter((c) => !afterAuth.includes(c));
    if (added.length > 0 || removed.length > 0) {
      const parts: string[] = [];
      if (added.length > 0) parts.push(`added ${added.join(", ")}`);
      if (removed.length > 0) parts.push(`removed ${removed.join(", ")}`);
      auditDescriptions.push(
        `${afterEmp.name}'s foreign-company authorizations changed (${parts.join("; ")}) by ${roleLabel}`
      );
    }
  }

  if (updates.active !== undefined && updates.active !== beforeEmp.active) {
    auditDescriptions.push(
      `${afterEmp.name} ${afterEmp.active ? "reactivated" : "deactivated"} by ${roleLabel}`
    );
  }

  if (auditDescriptions.length > 0) {
    const { data: lastStep } = await supabase
      .from("audit_log_entries")
      .select("step_number")
      .order("step_number", { ascending: false })
      .limit(1)
      .single();
    let nextStep = (lastStep?.step_number ?? 0) + 1;

    await supabase.from("audit_log_entries").insert(
      auditDescriptions.map((description) => ({
        id: `audit-${nextStep}`,
        step_number: nextStep++,
        description,
      }))
    );
  }

  return NextResponse.json({ employee: afterEmp });
}
