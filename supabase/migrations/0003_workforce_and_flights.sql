-- Additive migration — run AFTER 0001_init.sql and 0002_weekly_planning.sql.
-- Adds the team/qualification distinction, foreign-company authorization,
-- and flight-tracker-style metadata fields. No existing column is altered
-- or dropped.

alter table employees add column if not exists default_team text not null default 'General T1 Pool';
alter table employees add column if not exists foreign_company_authorizations jsonb not null default '[]'::jsonb;

alter table flights add column if not exists origin text;
alter table flights add column if not exists destination text;
alter table flights add column if not exists scheduled_arrival text;
alter table flights add column if not exists equipment_code text;
alter table flights add column if not exists registration text;
alter table flights add column if not exists callsign text;
alter table flights add column if not exists terminal text;

-- After running this, click "Reset Demo" (or re-run the seed script) to
-- repopulate all tables with the expanded workforce and full-week schedule.
