-- Additive migration — run AFTER 0001 through 0008.
-- Introduces the WeeklyPlan lifecycle aggregate (see lib/planning/
-- weekly-plan-service.ts): every plan-scoped roster row and assignment
-- now belongs to a specific, durable WeeklyPlan instead of floating
-- outside planning context, and Generate/Regenerate/Publish become real,
-- explicit operations instead of "recompute on every page load."

create table weekly_plans (
  id text primary key,
  week_start text not null,
  week_label text not null,
  status text not null default 'draft',
  revision integer not null default 1,
  generated_at timestamptz not null default now(),
  published_at timestamptz,
  generated_from_hash text not null,
  config_snapshot jsonb not null,
  issues jsonb not null default '[]'::jsonb,
  configuration_issues jsonb not null default '[]'::jsonb
);

-- The persisted result of "when is this employee planned to work this
-- week" — one row per (plan, employee, day), for every employee group
-- alike (fixed-cycle, foreign-committed, flexible General T1 Pool). See
-- lib/planning/duty-generation.ts's resolvePlanRosterEntry.
create table weekly_plan_roster_entries (
  id text primary key,
  plan_id text not null references weekly_plans(id) on delete cascade,
  employee_id text not null references employees(id) on delete cascade,
  day_of_week text not null,
  status text not null,
  shift_code text
);

create index idx_plan_roster_entries_plan on weekly_plan_roster_entries(plan_id);
create index idx_plan_roster_entries_employee on weekly_plan_roster_entries(employee_id);

-- assignments gains plan-scoping and provenance. Dropped and recreated
-- (rather than altered) so no pre-migration row can linger with a NULL
-- plan_id/source — as with every prior additive migration in this
-- project, click "Reset Demo" (or re-run the seed script) after running
-- this migration to regenerate and persist the first WeeklyPlan.
drop table if exists assignments cascade;

create table assignments (
  id text primary key,
  plan_id text not null references weekly_plans(id) on delete cascade,
  staffing_requirement_id text not null references staffing_requirements(id) on delete cascade,
  employee_id text not null references employees(id) on delete cascade,
  -- 'atlas_generated' | 'human_modified' — see lib/types.ts's
  -- AssignmentSource doc comment. Never a pending-recommendation status;
  -- both values represent a real, current assignment inside this plan.
  source text not null default 'atlas_generated',
  created_by text,
  assigned_at timestamptz not null default now()
);

create index idx_assignments_requirement on assignments(staffing_requirement_id);
create index idx_assignments_plan on assignments(plan_id);

-- Append-only structured history of human changes to a plan's
-- assignments — never a mutation of the live Assignment row itself, so
-- "what did ATLAS originally assign here?" stays answerable. Scoped by
-- plan_revision (not just plan_id) because Regenerate increments the
-- plan's revision — see lib/types.ts's AssignmentModification doc comment.
create table assignment_modifications (
  id text primary key,
  plan_id text not null references weekly_plans(id) on delete cascade,
  plan_revision integer not null,
  staffing_requirement_id text not null references staffing_requirements(id) on delete cascade,
  action text not null,
  previous_employee_id text references employees(id),
  new_employee_id text references employees(id),
  changed_by text not null,
  changed_at timestamptz not null default now(),
  reason text
);

create index idx_assignment_modifications_plan on assignment_modifications(plan_id);
create index idx_assignment_modifications_plan_revision on assignment_modifications(plan_id, plan_revision);

-- After running this migration, click "Reset Demo" (or re-run the seed
-- script) to generate and persist the first WeeklyPlan.
