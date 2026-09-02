import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { computeEmployeeDaySummary } from "@/lib/employee-status";
import { DEMO_TODAY } from "@/lib/seed-data";
import { Employee, Assignment, StaffingRequirement, Flight } from "@/lib/types";

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

export async function POST(req: Request) {
  const supabase = getSupabaseServerClient();
  const body = await req.json();

  const {
    name,
    skills,
    assignment = "General T1 Pool",
    shift_start,
    shift_end,
    rest_before_shift_hours,
    weekly_hours,
    is_duty_officer = false,
  } = body;

  if (!name || !Array.isArray(skills) || skills.length === 0 || !shift_start || !shift_end) {
    return NextResponse.json(
      { error: "name, skills (non-empty array), shift_start, and shift_end are required" },
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
      shift_start,
      shift_end,
      rest_before_shift_hours: Number(rest_before_shift_hours) || 0,
      weekly_hours: Number(weekly_hours) || 0,
      is_duty_officer: Boolean(is_duty_officer),
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ employee: data });
}

