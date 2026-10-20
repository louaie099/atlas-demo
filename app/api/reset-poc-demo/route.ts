import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { resetPocDemoDatabase } from "@/lib/reset-poc-demo";
import { requireAdminKey } from "@/lib/admin-guard";

export const dynamic = "force-dynamic";

/**
 * Loads the THIRD, purpose-built PoC demo dataset — see
 * lib/demo-poc/dataset.ts. This replaces whatever is currently in the
 * database (same tables as /api/reset and /api/reset-small-demo), same
 * full-wipe-and-reseed semantics; it does not run alongside either other
 * dataset. POST /api/reset or /api/reset-small-demo to switch to one of
 * those instead.
 */
export async function POST(req: Request) {
  const guard = requireAdminKey(req);
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const supabase = getSupabaseServerClient();
  try {
    await resetPocDemoDatabase(supabase);
    return NextResponse.json({ status: "reset", dataset: "poc-demo" });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
