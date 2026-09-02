-- Atlas Demo schema. Single-tenant, no RLS (out of scope per ADR-0003).
-- Safe to re-run: drops existing tables first, so a partially-created or
-- mismatched-type schema (e.g. a stray uuid `flights.id` from the table
-- editor) doesn't linger and break the foreign keys below.

drop table if exists audit_log_entries cascade;
drop table if exists planned_duties cascade;
drop table if exists assignments cascade;
drop table if exists staffing_requirements cascade;
drop table if exists flights cascade;
drop table if exists employees cascade;

create table employees (
  id text primary key,
  name text not null,
  roles jsonb not null,
  shift_start text not null,
  shift_end text not null,
  rest_before_shift_hours numeric not null,
  weekly_hours numeric not null,
  is_duty_officer boolean not null default false
);

create table flights (
  id text primary key,
  flight_number text not null,
  airline text not null,
  route text not null,
  aircraft text not null,
  scheduled_departure text not null,
  gate text,
  boarding_window_start text,
  boarding_window_end text,
  status text not null default 'scheduled',
  booking_pressure text not null default 'normal'
);

create table staffing_requirements (
  id text primary key,
  flight_id text not null references flights(id) on delete cascade,
  role text not null,
  baseline_requirement integer not null,
  additional_requirement integer not null default 0,
  total_requirement integer not null,
  source text not null,
  reasoning text not null
);

create table assignments (
  id text primary key,
  staffing_requirement_id text not null references staffing_requirements(id) on delete cascade,
  employee_id text not null references employees(id) on delete cascade,
  assigned_at timestamptz not null default now()
);

create table planned_duties (
  id text primary key,
  employee_id text not null references employees(id) on delete cascade,
  task text not null,
  planned_start text not null,
  status text not null default 'planned',
  reassigned_to_employee_id text references employees(id)
);

create table audit_log_entries (
  id text primary key,
  step_number integer not null,
  description text not null,
  timestamp timestamptz not null default now()
);

create index idx_assignments_requirement on assignments(staffing_requirement_id);
create index idx_staffing_requirements_flight on staffing_requirements(flight_id);
create index idx_planned_duties_employee on planned_duties(employee_id);
