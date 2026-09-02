-- Additive migration — run AFTER 0001, 0002, 0003.
-- Adds the authoritative shift code reference. Nullable: some
-- scenario-critical employees intentionally predate the shift catalog
-- (see lib/seed-data.ts comments, e.g. Karim Idrissi).

alter table employees add column if not exists shift_code text;

-- After running this, click "Reset Demo" (or re-run the seed script) to
-- repopulate employees with their assigned shift codes.
