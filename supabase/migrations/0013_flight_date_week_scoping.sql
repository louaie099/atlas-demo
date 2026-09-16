-- Multi-week Flight Program foundation. Today there is exactly ONE set of
-- flights in this table at all -- day_of_week is a weekday LABEL, not tied
-- to any specific calendar week, so "next week" and "previous week" have
-- never had real, different data behind them (see WeekNav's hasData prop,
-- which is currently just a client-side offset with no backing query).
--
-- flight_date is the actual operating date (the real, chronological
-- source of truth -- required for cross-week rest/roster continuity,
-- which needs genuine calendar adjacency, not a repeating Monday-Sunday
-- label). week_start is a pure grouping/indexing key (the Monday of
-- flight_date's display week) for efficient per-week queries -- never the
-- thing chronological logic should reason from directly.
--
-- After running this, click "Reset Demo" (or re-run the seed script) to
-- repopulate flights with real dates going forward; the backfill below
-- only fixes up whatever is already in the table at migration time.

alter table flights add column if not exists week_start date;
alter table flights add column if not exists flight_date date;

-- Backfill: every flight currently in this table belongs to the single
-- demo week (Monday Sep 1 2026), so its flight_date is derivable purely
-- from day_of_week. This is a one-time correction for pre-existing rows,
-- not a general rule -- new rows must always be inserted with real,
-- explicit dates from here on.
update flights set
  week_start = '2026-09-01'::date,
  flight_date = '2026-09-01'::date + (case day_of_week
    when 'Monday' then 0
    when 'Tuesday' then 1
    when 'Wednesday' then 2
    when 'Thursday' then 3
    when 'Friday' then 4
    when 'Saturday' then 5
    when 'Sunday' then 6
    else 0
  end)
where week_start is null or flight_date is null;

alter table flights alter column week_start set not null;
alter table flights alter column flight_date set not null;

-- flight_date's actual weekday must always agree with day_of_week -- a
-- database-level guarantee, not just an application-code assumption,
-- since day_of_week is still what most existing planning code reads
-- directly.
alter table flights add constraint flights_date_matches_day_of_week check (
  extract(dow from flight_date)::int = case day_of_week
    when 'Sunday' then 0
    when 'Monday' then 1
    when 'Tuesday' then 2
    when 'Wednesday' then 3
    when 'Thursday' then 4
    when 'Friday' then 5
    when 'Saturday' then 6
  end
);

-- Real-world identity for a flight occurrence going forward: a specific
-- flight number on a specific calendar date. Replaces the old implicit
-- "id is whatever the seed script slugified" as the actual duplicate
-- guard for Import Flights / Add Flight.
alter table flights add constraint flights_date_number_unique unique (flight_date, flight_number);

create index if not exists flights_week_start_idx on flights (week_start);
