import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { canManageEmployees } from "@/lib/roles";
import { resolveRole } from "@/lib/resolve-role";
import { validateImportFile } from "@/lib/employee-import";

export const dynamic = "force-dynamic";

/**
 * POST /api/employees/import/commit — Import Employees, CONFIRM step.
 * Takes the SAME csv the preview step was given (re-validating from
 * scratch here, rather than trusting a client-echoed row list, closes the
 * gap where someone else could have created a colliding employee id
 * between preview and confirm -- same reasoning as Import Flights'
 * commit route) and inserts every row that is NOT rejected ("ready" and
 * "warning" rows both commit -- a warning means "will need configuration
 * before it's fully usable," not "don't import"). Rejected rows are never
 * inserted, under any circumstance.
 *
 * Inserted rows get planning state as null (shift_start, shift_end,
 * rest_before_shift_hours, weekly_hours, shift_code) and no weekly_shifts
 * -- identical to a single employee created through POST /api/employees:
 * a bulk-imported employee has no roster yet until Weekly Planning
 * generates one, exactly like one added by hand.
 */
export async function POST(req: Request) {
  const role = await resolveRole(req);
  if (!canManageEmployees(role)) {
    return NextResponse.json({ error: "Administrator permission required to import employees." }, { status: 403 });
  }

  const supabase = getSupabaseServerClient();
  const body = await req.json();
  const { csv } = body;

  if (!csv || typeof csv !== "string") {
    return NextResponse.json({ error: "csv (file contents as text) is required" }, { status: 400 });
  }

  const { data: existing, error: fetchErr } = await supabase.from("employees").select("id");
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  const existingIds = new Set((existing ?? []).map((e) => e.id as string));

  let rows;
  try {
    rows = validateImportFile(csv, existingIds);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }

  const toInsert = rows
    .filter((r) => r.employee !== null)
    .map((r) => ({
      ...r.employee!,
      shift_start: null,
      shift_end: null,
      rest_before_shift_hours: null,
      weekly_hours: null,
    }));

  if (toInsert.length === 0) {
    return NextResponse.json({ imported: 0, rows });
  }

  const { error: insertErr } = await supabase.from("employees").insert(toInsert);
  if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });

  return NextResponse.json({ imported: toInsert.length, rows });
}
