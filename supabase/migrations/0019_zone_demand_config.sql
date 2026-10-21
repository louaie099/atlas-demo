-- Editable T1 Check-in baseline per zone (lib/planning/zone-demand-settings.ts).
-- Single mutable "current settings" row, same convention as planning_fatigue_config.
-- Missing row = never edited -> the code falls back to DEFAULT_ZONE_BASE_SETTING.
-- Deliberately NOT wiped by any Reset Demo action: it is configuration.
create table planning_zone_demand_config (
  id text primary key default 'current',
  config jsonb not null,
  updated_at timestamptz not null default now()
);
