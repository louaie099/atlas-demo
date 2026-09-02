import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { generateDraftWeeklyPlan } from "@/lib/planning/generate-draft-plan";
import { CONFIG, DAYS_WITH_DATA, CURRENT_WEEK_LABEL } from "@/lib/seed-data";
import { Employee, Flight, Assignment } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Exposes the generated Draft Weekly Plan — read-only, computes fresh on
 * every request from current data, writes nothing back to the database.
 * Not yet wired into the Weekly Planning page's UI — this exists so the
 * pipeline is real and consumable, per the explicit instruction to
 * establish the domain layer before redesigning the interface.
 */
export async function GET() {
  const supabase = getSupabaseServerClient();

  const [{ data: flights, error: flightErr }, { data: employees, error: empErr }, { data: assignments, error: assignErr }] =
    await Promise.all([
      supabase.from("flights").select("*"),
      supabase.from("employees").select("*"),
      supabase.from("assignments").select("*"),
    ]);

  if (flightErr || empErr || assignErr) {
    return NextResponse.json({ error: (flightErr || empErr || assignErr)?.message }, { status: 500 });
  }

  const plan = generateDraftWeeklyPlan(
    flights as Flight[],
    employees as Employee[],
    assignments as Assignment[],
    CONFIG,
    DAYS_WITH_DATA,
    CURRENT_WEEK_LABEL
  );

  return NextResponse.json({ plan });
}
