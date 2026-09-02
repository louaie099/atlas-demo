import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { computeEmployeeDaySummary } from "@/lib/employee-status";
import { DEMO_TODAY } from "@/lib/seed-data";
import { Employee, Assignment, StaffingRequirement, Flight } from "@/lib/types";
import { ROLE_HEADER, getRoleFromHeader, canManageEmployees } from "@/lib/roles";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = getSupabaseServerClient();

  const [{ data: employees, error: empErr }, { data: assignments, error: assignErr }, { data: requirements, error: reqErr }, { data: flights, error: flightErr }] =
    await Promise.all([
      supabase.from("employees").select("*").order("name", { ascending: true }),
      supabase.from("assignments").select("*"),
      supabase.from("staffing_requirements").select("*"),
      supabase.from("flights").select("*"),
    ]);

  if (empErr || assignErr || reqErr || flightErr) {
    return NextResponse.json({ error: (empErr || assignErr || reqErr || flightErr)?.message }, { status: 500 });
  }

  // Enrich each employee with today's operational status, computed from
  // real assignment data — the whole point of moving beyond a static list.
  const enriched = (employees as Employee[]).map((e) => {
    const today = computeEmployeeDaySummary(
      e,
      DEMO_TODAY,
      assignments as Assignment[],
      requirements as StaffingRequirement[],
      flights as Flight[]
    );
    return { ...e, today };
  });

  return NextResponse.json({ employees: enriched, demoToday: DEMO_TODAY });
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Creates an employee's WORKFORCE PROFILE only — who they are, what
 * they're qualified/authorized to do, and where they're currently placed.
 * Deliberately does NOT accept or invent shift_start, shift_end,
 * rest_before_shift_hours, or weekly_hours: those are planning state that
 * belongs to Weekly Planning/roster generation, not employee creation.
 * They're inserted as null (see migration 0007) — this employee has no
 * roster yet, which is honest, not a placeholder to work around.
 *
 * Also does not create any Assignment or weekly_shifts entry, even if
 * `assignment` is a foreign company — a real flight commitment is only
 * ever generated from that company's actual scheduled flights (see
 * lib/foreign-shift-planning.ts), never fabricated at creation time.
 *
 * PERMISSION ENFORCEMENT: only Administrators may create employees (see
 * lib/roles.ts). This is checked HERE, server-side — the frontend also
 * hides/disables the Add Employee control for non-admins, but that's a UX
 * courtesy, not the actual security boundary. A request without a valid
 * Administrator role header is rejected regardless of what the UI showed.
 */
export async function POST(req: Request) {
  const role = getRoleFromHeader(req.headers.get(ROLE_HEADER));
  if (!canManageEmployees(role)) {
    return NextResponse.json(
      { error: "Administrator permission required to create employees." },
      { status: 403 }
    );
  }

  const supabase = getSupabaseServerClient();
  const body = await req.json();

  const {
    name,
    skills,
    assignment = "General T1 Pool",
    foreign_company_authorizations = [],
    is_duty_officer = false,
  } = body;

  if (!name || !Array.isArray(skills) || skills.length === 0 || !assignment) {
    return NextResponse.json(
      { error: "name, skills (non-empty array), and assignment are required" },
      { status: 400 }
    );
  }

  const id = slugify(name);

  const { data: existing } = await supabase.from("employees").select("id").eq("id", id).maybeSingle();
  if (existing) {
    return NextResponse.json({ error: `An employee with id "${id}" already exists` }, { status: 409 });
  }

  const { data, error } = await supabase
    .from("employees")
    .insert({
      id,
      name,
      skills,
      assignment,
      foreign_company_authorizations,
      shift_code: null,
      shift_start: null,
      shift_end: null,
      rest_before_shift_hours: null,
      weekly_hours: null,
      is_duty_officer: Boolean(is_duty_officer),
      active: true,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ employee: data });
}

