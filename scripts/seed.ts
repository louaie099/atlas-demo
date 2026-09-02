import "dotenv/config";
import { getSupabaseServerClient } from "../lib/supabase-server";
import { resetDatabase } from "../lib/reset-database";

async function main() {
  const supabase = getSupabaseServerClient();
  console.log("Seeding Atlas demo database...");
  await resetDatabase(supabase);
  console.log("Done. Employees, flights, staffing requirements, initial assignments, and audit log seeded.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
