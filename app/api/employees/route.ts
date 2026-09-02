import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase.from("employees").select("*").order("name", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ employees: data });
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
    roles,
    shift_start,
    shift_end,
    rest_before_shift_hours,
    weekly_hours,
    is_duty_officer = false,
  } = body;

  if (!name || !Array.isArray(roles) || roles.length === 0 || !shift_start || !shift_end) {
    return NextResponse.json(
      { error: "name, roles (non-empty array), shift_start, and shift_end are required" },
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
      roles,
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

