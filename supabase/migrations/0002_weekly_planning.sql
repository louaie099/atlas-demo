-- Additive migration — run this AFTER 0001_init.sql. Does not drop any
-- existing table or data structure; only adds columns needed for the
-- schedule-driven Weekly Planning redesign.

alter table employees add column if not exists off_days jsonb not null default '[]'::jsonb;

alter table flights add column if not exists day_of_week text not null default 'Wednesday';
alter table flights add column if not exists operator_type text not null default 'atlas_managed';
alter table flights add column if not exists destination_category text;

alter table staffing_requirements add column if not exists needs_configuration boolean not null default false;

-- After running this, click "Reset Demo" in the app (or re-run the seed
-- script) to repopulate all tables with the new fields and flights.
