import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { resetDatabase } from "@/lib/reset-database";
import { requireAdminKey } from "@/lib/admin-guard";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guard = requireAdminKey(req);
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const supabase = getSupabaseServerClient();
  try {
    await resetDatabase(supabase);
    return NextResponse.json({ status: "reset" });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
