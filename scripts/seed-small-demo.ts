import "dotenv/config";
import { getSupabaseServerClient } from "../lib/supabase-server";
import { resetSmallDemoDatabase } from "../lib/reset-small-demo";

async function main() {
  const supabase = getSupabaseServerClient();
  console.log("Seeding ATLAS small demo database (UI/manual-testing dataset)...");
  await resetSmallDemoDatabase(supabase);
  console.log("Done. ~22 employees, a full week of flights, staffing requirements, draft plan, and audit log seeded.");
  console.log("This REPLACES whatever was in the database (same tables as the main seed) — run `npm run seed` to switch back to the full stress-test dataset.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
