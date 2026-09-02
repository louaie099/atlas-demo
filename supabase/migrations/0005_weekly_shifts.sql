-- Additive migration — run AFTER 0001, 0002, 0003, 0004.
-- Foundation for day-by-day weekly planning: one shift-code-or-off entry
-- per day of the current week, per employee. Currently populated
-- uniformly (see lib/shift-templates.ts buildUniformWeeklySchedule) —
-- real day-to-day variation is future Weekly Planning work, not this step.

alter table employees add column if not exists weekly_shifts jsonb not null default '[]'::jsonb;

-- After running this, click "Reset Demo" (or re-run the seed script) to
-- repopulate employees with their day-by-day schedule.
