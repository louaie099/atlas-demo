-- Cleanup: the read-after-write investigation that plan_connection_
-- diagnostics (migration 0011) was built for is closed -- root cause
-- found (an uncached-GET fix in the app's Supabase client, not a
-- database-level issue) and confirmed fixed. Drop the now-unused
-- diagnostic function; nothing in the application calls it anymore.
drop function if exists plan_connection_diagnostics(text);
