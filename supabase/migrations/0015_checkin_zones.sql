-- Additive migration — run AFTER 0001 through 0014.
--
-- T1 Check-in ZONE requirements/assignments — a PARALLEL model to
-- staffing_requirements/assignments, not a retrofit of them.
-- staffing_requirements.flight_id and the whole assignments chain are
-- NOT NULL foreign keys to exactly one flight (see 0001_init.sql,
-- 0009_weekly_plan_lifecycle.sql) — every existing requirement/assignment
-- row is hard-anchored to a single flight. Retrofitting that to support a
-- one-to-many (zone -> contributing flights) relationship would risk
-- breaking Gate/Boarding/Profiling/Mesure/foreign-company, which correctly
-- remain flight-specific and must NOT change. Instead, this migration adds
-- a new, coexisting concept — analogous to how Profiling/Mesure's
-- time-bucket aggregation already sits as its own downstream layer next to
-- the untouched per-flight model.
--
-- See lib/checkin-zones.ts for the zone taxonomy and
-- lib/planning/zone-demand-aggregation.ts for how the required_headcount
-- values this table holds are computed.

create table if not exists checkin_zone_requirements (
  id text primary key,
  plan_id text not null references weekly_plans(id) on delete cascade,
  -- One of lib/checkin-zones.ts's CheckinZoneId values (t1_main_checkin,
  -- t1_business_checkin, t1_italy_spain, t1_domestic, t1_staff_checkin,
  -- t1_oversized_baggage). Not a foreign key to a zones table — the zone
  -- taxonomy is application config (lib/checkin-zones.ts), not
  -- database-owned data, exactly like StaffingRequirement.role is a plain
  -- text value validated against application config, not a DB enum.
  zone text not null,
  day_of_week text not null,
  window_start text not null,
  window_end text not null,
  required_headcount integer not null default 0,
  -- 'automatic' (produced by the zone demand engine) | 'manual' (a human/
  -- config-entered requirement for a demandMode:"manual" zone — Business/
  -- Staff/Oversized Baggage never get an automatic formula; see
  -- lib/checkin-zones.ts's CheckinZoneDemandMode). Mirrors the
  -- confirmed-vs-manual distinction the rest of this codebase already
  -- makes explicit rather than blurring it into one opaque "source".
  source text not null default 'automatic',
  reasoning text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_checkin_zone_requirements_plan on checkin_zone_requirements(plan_id);
create index if not exists idx_checkin_zone_requirements_plan_day_zone on checkin_zone_requirements(plan_id, day_of_week, zone);

-- The real, normalized relationship to CONTRIBUTING FLIGHTS — a genuine
-- join table, not a JSON array locked into checkin_zone_requirements
-- itself, per the explicit instruction that a normalized relationship is
-- more appropriate here (it lets "which zone requirements does flight X
-- feed into" be queried directly, and keeps referential integrity to
-- flights(id) real rather than implicit).
create table if not exists checkin_zone_requirement_contributing_flights (
  zone_requirement_id text not null references checkin_zone_requirements(id) on delete cascade,
  flight_id text not null references flights(id) on delete cascade,
  primary key (zone_requirement_id, flight_id)
);

create index if not exists idx_zone_req_contrib_flight on checkin_zone_requirement_contributing_flights(flight_id);

-- Zone assignments — mirrors the existing `assignments` table's
-- conventions closely (source/created_by/assigned_at) so Draft/Published/
-- human-modification/audit semantics generalize naturally, per a zone
-- requirement instead of a staffing_requirement.
create table if not exists checkin_zone_assignments (
  id text primary key,
  plan_id text not null references weekly_plans(id) on delete cascade,
  zone_requirement_id text not null references checkin_zone_requirements(id) on delete cascade,
  employee_id text not null references employees(id) on delete cascade,
  -- This EMPLOYEE's own actual covered interval within the parent zone
  -- requirement's (possibly wider) demand window -- e.g. a requirement
  -- spanning 07:00-09:15 can have one employee covering only 07:00-08:00
  -- of it (their free interval was shorter -- see
  -- lib/planning/checkin-zone-placement.ts). Deliberately NOT assumed to
  -- equal the parent requirement's window_start/window_end, so Agent
  -- Schedule renders "T1 Main Check-in · counters 30–76 · 05:45–08:30"
  -- as this employee's REAL covered time, never the zone's aggregate
  -- demand window.
  window_start text not null,
  window_end text not null,
  -- 'atlas_generated' | 'human_modified' — identical vocabulary to
  -- assignments.source (lib/types.ts's AssignmentSource), so Find Agent's
  -- existing "human modification against a draft plan" semantics apply
  -- unchanged to a zone-requirement gap fill.
  source text not null default 'atlas_generated',
  created_by text,
  assigned_at timestamptz not null default now()
);

create index if not exists idx_checkin_zone_assignments_requirement on checkin_zone_assignments(zone_requirement_id);
create index if not exists idx_checkin_zone_assignments_plan on checkin_zone_assignments(plan_id);

-- After running this migration, click "Reset Demo" (or re-run the seed
-- script) to regenerate a WeeklyPlan; existing plans have no
-- checkin_zone_requirements/checkin_zone_assignments rows until
-- regenerated.
