import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { canManageEmployees } from "@/lib/roles";
import { resolveRole } from "@/lib/resolve-role";
import { validateImportFile } from "@/lib/employee-import";

export const dynamic = "force-dynamic";

/**
 * POST /api/employees/import — Import Employees, PREVIEW step. Parses and
 * validates the submitted CSV against every already-persisted employee id,
 * but writes nothing: the person reviews ready/warning/rejected counts and
 * the actual parsed rows before anything is committed. Same two-step
 * preview/commit shape as Import Flights (lib/flight-import.ts) on
 * purpose -- a bulk way to onboard a real pilot team's roster without
 * creating employees one at a time through the UI.
 *
 * PERMISSION ENFORCEMENT: only Administrators may import employees, same
 * rule as POST /api/employees (single-employee creation) -- checked here,
 * server-side, not just hidden in the UI.
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

  const { data: existing, error } = await supabase.from("employees").select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const existingIds = new Set((existing ?? []).map((e) => e.id as string));

  try {
    const rows = validateImportFile(csv, existingIds);
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
