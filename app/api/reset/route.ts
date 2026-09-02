import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { resetDatabase } from "@/lib/reset-database";

export const dynamic = "force-dynamic";

export async function POST() {
  const supabase = getSupabaseServerClient();
  try {
    await resetDatabase(supabase);
    return NextResponse.json({ status: "reset" });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
