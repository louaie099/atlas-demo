-- TEMPORARY, additive-only: part of the deployed weekly-view/make-planning
-- read-after-write divergence investigation. Exposes non-secret Postgres
-- session/connection facts alongside a weekly_plans row so the two code
-- paths (verifyPlanPersisted vs loadPersistedPlanView) can be compared
-- for whether they are actually served by the same physical backend.
--
-- pg_is_in_recovery() is the decisive field: it is TRUE only when the
-- query is answered by a streaming READ REPLICA, FALSE on the primary.
-- If make-planning's verification read reports false and weekly-view's
-- read reports true for the same plan id, that is direct proof this is
-- a primary/replica split, not an application bug.
--
-- pg_backend_pid()/inet_server_addr()/inet_server_port() are included as
-- a secondary signal: even without replicas, two requests answered by
-- different physical Postgres backends/hosts would show different
-- values here despite going through the "same" Supabase project.
--
-- Remove this function once the investigation concludes.
create or replace function plan_connection_diagnostics(p_plan_id text)
returns table (
  id text,
  revision integer,
  generated_at timestamptz,
  backend_pid integer,
  server_addr text,
  server_port integer,
  in_recovery boolean
)
language sql
security definer
set search_path = public
as $$
  select
    wp.id,
    wp.revision,
    wp.generated_at,
    pg_backend_pid(),
    inet_server_addr()::text,
    inet_server_port(),
    pg_is_in_recovery()
  from weekly_plans wp
  where wp.id = p_plan_id;
$$;

grant execute on function plan_connection_diagnostics(text) to service_role;
