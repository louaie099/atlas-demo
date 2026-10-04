import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { resetSmallDemoDatabase } from "@/lib/reset-small-demo";

export const dynamic = "force-dynamic";

/**
 * Loads the SEPARATE small (~22-employee) UI/manual-testing dataset —
 * see lib/demo-small/dataset.ts. This replaces whatever is currently in
 * the database (same tables as /api/reset), same full-wipe-and-reseed
 * semantics; it does not run alongside the main dataset. POST
 * /api/reset to switch back to the full stress-test dataset.
 */
export async function POST() {
  const supabase = getSupabaseServerClient();
  try {
    await resetSmallDemoDatabase(supabase);
    return NextResponse.json({ status: "reset", dataset: "small-demo" });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
