import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
export const dynamic = "force-dynamic";

import { validateImportFile } from "@/lib/flight-import";

/**
 * POST /api/flights/import — Import Flights, PREVIEW step. Parses and
 * validates the submitted CSV against the given week's already-persisted
 * flights, but writes nothing: the person reviews imported/warning/
 * rejected counts and the actual parsed rows before anything is
 * committed. This route is flight-program input only — it never touches
 * staffing requirements, rosters, or any WeeklyPlan.
 */
export async function POST(req: Request) {
  const supabase = getSupabaseServerClient();
  const body = await req.json();
  const { csv, week_start } = body;

  if (!csv || typeof csv !== "string") {
    return NextResponse.json({ error: "csv (file contents as text) is required" }, { status: 400 });
  }
  if (!week_start) {
    return NextResponse.json({ error: "week_start is required" }, { status: 400 });
  }

  const { data: existing, error } = await supabase.from("flights").select("flight_date, flight_number").eq("week_start", week_start);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const existingKeys = new Set((existing ?? []).map((f) => `${f.flight_date}|${f.flight_number}`));

  try {
    const rows = validateImportFile(csv, existingKeys);
    const summary = {
      total: rows.length,
      ready: rows.filter((r) => r.status === "ready").length,
      warnings: rows.filter((r) => r.status === "warning").length,
      rejected: rows.filter((r) => r.status === "rejected").length,
    };
    return NextResponse.json({ summary, rows });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
