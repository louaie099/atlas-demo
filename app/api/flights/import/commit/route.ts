import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
export const dynamic = "force-dynamic";

import { validateImportFile } from "@/lib/flight-import";

/**
 * POST /api/flights/import/commit — Import Flights, CONFIRM step. Takes
 * the SAME csv + week_start the preview step was given (re-validating
 * from scratch here, rather than trusting a client-echoed row list,
 * closes the gap where someone else could have added a colliding flight
 * between preview and confirm) and inserts every row that is NOT
 * rejected ("ready" and "warning" rows both commit — a warning means
 * "will need configuration before it gets coverage," not "don't
 * import"). Rejected rows are never inserted, under any circumstance.
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

  const { data: existing, error: fetchErr } = await supabase.from("flights").select("flight_date, flight_number").eq("week_start", week_start);
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  const existingKeys = new Set((existing ?? []).map((f) => `${f.flight_date}|${f.flight_number}`));

  let rows;
  try {
    rows = validateImportFile(csv, existingKeys, week_start);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }

  const toInsert = rows.filter((r) => r.flight !== null).map((r) => r.flight!);
  if (toInsert.length === 0) {
    return NextResponse.json({ imported: 0, rows });
  }

  const { error: insertErr } = await supabase.from("flights").insert(toInsert);
  if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });

  return NextResponse.json({ imported: toInsert.length, rows });
}
