-- Additive/renaming migration — run AFTER 0001 through 0005.
-- Renames columns to match the corrected skill-vs-assignment domain model:
--   roles         -> skills      (capability: what an employee can do)
--   default_team  -> assignment  (current placement: internal service OR
--                                 a foreign company name — see
--                                 lib/company-config.ts)
-- Postgres preserves each column's type, not-null constraint, and default
-- value across a rename, so no data is lost and no re-seed is strictly
-- required for this step alone — though a Reset Demo afterward is still
-- recommended to pick up the corrected seed data (Nadia's Transit
-- qualification removed, new foreign-company assignment examples, Baggage
-- Claim team, Gulf Air / Air France configs).

alter table employees rename column roles to skills;
alter table employees rename column default_team to assignment;
