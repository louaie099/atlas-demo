-- Phase 1 security work -- see docs/known-limitations/auth-and-rls.md for
-- the full picture. Additive migration, run AFTER every prior one.
--
-- WHAT THIS DOES NOT DO YET: every app/api/* route still reads and writes
-- through lib/supabase-server.ts's SERVICE-ROLE client, which bypasses RLS
-- entirely by design. Applying this migration is therefore safe to run
-- immediately -- it changes nothing about how the app behaves today -- but
-- it is NOT yet the thing actually stopping an unauthorized write. The real
-- enforcement today is still lib/resolve-role.ts (a real session's role, or
-- "viewer") plus each route's own canManage*() check. These policies are
-- Phase 1b groundwork: once routes are migrated from the service-role
-- client to a per-request client scoped to the signed-in user (so a bug or
-- an omitted check in a route can no longer silently do more than that
-- user is allowed), THIS is what will actually hold the line at the
-- database layer, as defense in depth rather than the only layer.
--
-- THIS FILE HAS NOT BEEN RUN AGAINST A LIVE SUPABASE PROJECT. Run it in a
-- staging project first, confirm the app still behaves identically (it
-- should -- see above), and only then apply it to the real project.

-- One row per Supabase Auth user, holding the SAME three-level role
-- lib/roles.ts has always used (not a parallel role system). A user with
-- no row here is treated as the least-privileged role everywhere that reads
-- this table (see lib/auth-server.ts's getAuthenticatedIdentity, which
-- already applies this exact fallback) -- never silently elevated just for
-- having an account.
create table user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('viewer', 'planner', 'administrator')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table user_roles enable row level security;

-- A signed-in user may read their OWN role row (so the client can show
-- "you are a Planner", if ever needed) -- never anyone else's, and never an
-- insert/update/delete: role assignment is an administrative act performed
-- with the service-role key (or the Supabase dashboard), not something a
-- user can grant themselves.
create policy "user_roles: read own row"
  on user_roles for select
  using (auth.uid() = user_id);

-- Security-definer lookup, callable by any authenticated user, that avoids
-- a user needing direct SELECT visibility into arbitrary rows of
-- user_roles just to evaluate "what is MY role" inside another table's
-- policy (search_path pinned, per Supabase's own guidance for
-- security-definer functions, to avoid a schema-shadowing attack).
create or replace function current_app_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from user_roles where user_id = auth.uid();
$$;

-- Every real data table gets RLS enabled. Read access: any signed-in user
-- with an assigned role (viewer and up). Write access mirrors the same
-- administrator/planner boundaries lib/roles.ts's canManageEmployees /
-- canManageOperations / canManageLaborRules already enforce in the route
-- handlers -- this is the SAME rule, expressed twice (app layer today, DB
-- layer once Phase 1b lands), not a different one.
do $$
declare
  administrator_only text[] := array['employees', 'planning_labor_rules', 'planning_fatigue_config'];
  planner_and_up text[] := array[
    'flights', 'staffing_requirements', 'assignments', 'assignment_modifications',
    'weekly_plans', 'weekly_plan_roster_entries', 'planned_duties',
    'checkin_zone_requirements', 'checkin_zone_requirement_contributing_flights',
    'checkin_zone_assignments', 'audit_log_entries'
  ];
  t text;
begin
  foreach t in array administrator_only || planner_and_up loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for select using (current_app_role() is not null)',
      t || '_select_any_role', t
    );
  end loop;

  foreach t in array administrator_only loop
    execute format(
      'create policy %I on %I for all using (current_app_role() = ''administrator'') with check (current_app_role() = ''administrator'')',
      t || '_write_administrator_only', t
    );
  end loop;

  foreach t in array planner_and_up loop
    execute format(
      'create policy %I on %I for all using (current_app_role() in (''planner'', ''administrator'')) with check (current_app_role() in (''planner'', ''administrator''))',
      t || '_write_planner_and_up', t
    );
  end loop;
end $$;
