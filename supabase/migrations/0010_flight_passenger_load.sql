-- Additive migration — run AFTER 0001 through 0009.
--
-- Fixes a pre-existing schema drift bug, unrelated to the weekly-plan
-- lifecycle work in 0009: lib/types.ts's Flight interface and
-- lib/seed-data.ts's FLIGHTS have carried booked_passengers/seat_capacity
-- (passenger-load fields, architecture-only for now — see that doc
-- comment in lib/types.ts) since an earlier milestone, but no migration
-- ever added the columns to the live `flights` table. Reset Demo's
-- seeding therefore fails with "Could not find the 'booked_passengers'
-- column of 'flights' in the schema cache" on any Supabase project,
-- however up to date, that only has 0001-0009 applied.
alter table flights add column if not exists booked_passengers integer;
alter table flights add column if not exists seat_capacity integer;

-- After running this, click "Reset Demo" (or re-run the seed script) to
-- repopulate flights with their passenger-load fields.
