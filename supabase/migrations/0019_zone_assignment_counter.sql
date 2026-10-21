-- A regulator can pin a manual T1 zone assignment to a specific counter
-- (Live Operations). Nullable: existing rows and zone-level assignments
-- simply have no counter. The app keeps working (counter not saved) if this
-- column has not been added yet.
alter table checkin_zone_assignments add column if not exists counter integer;
