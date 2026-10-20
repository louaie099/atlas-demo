import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { resetToEmptyDatabase } from "@/lib/reset-empty";
import { requireAdminKey } from "@/lib/admin-guard";

export const dynamic = "force-dynamic";

/**
 * POST /api/reset-empty — wipes every table, leaves the database
 * genuinely empty (no dataset reseeded, no plan generated). The
 * counterpart to /api/reset, /api/reset-small-demo and
 * /api/reset-poc-demo, which all wipe-then-reseed one specific dataset;
 * this route only wipes. See lib/reset-empty.ts's doc comment for the
 * full rationale behind separating these two actions.
 */
export async function POST(req: Request) {
  const guard = requireAdminKey(req);
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const supabase = getSupabaseServerClient();
  try {
    await resetToEmptyDatabase(supabase);
    return NextResponse.json({ status: "reset", dataset: null });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
