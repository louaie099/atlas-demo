-- Atlas Demo schema. Single-tenant, no RLS (out of scope per ADR-0003).
-- Run this once in the Supabase SQL editor before using the app.

create table if not exists employees (
  id text primary key,
  name text not null,
  roles jsonb not null,
  shift_start text not null,
  shift_end text not null,
  rest_before_shift_hours numeric not null,
  weekly_hours numeric not null,
  is_duty_officer boolean not null default false
);

create table if not exists flights (
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

create table if not exists staffing_requirements (
  id text primary key,
  flight_id text not null references flights(id) on delete cascade,
  role text not null,
  baseline_requirement integer not null,
  additional_requirement integer not null default 0,
  total_requirement integer not null,
  source text not null,
  reasoning text not null
);

create table if not exists assignments (
  id text primary key,
  staffing_requirement_id text not null references staffing_requirements(id) on delete cascade,
  employee_id text not null references employees(id) on delete cascade,
  assigned_at timestamptz not null default now()
);

create table if not exists planned_duties (
  id text primary key,
  employee_id text not null references employees(id) on delete cascade,
  task text not null,
  planned_start text not null,
  status text not null default 'planned',
  reassigned_to_employee_id text references employees(id)
);

create table if not exists audit_log_entries (
  id text primary key,
  step_number integer not null,
  description text not null,
  timestamp timestamptz not null default now()
);

create index if not exists idx_assignments_requirement on assignments(staffing_requirement_id);
create index if not exists idx_staffing_requirements_flight on staffing_requirements(flight_id);
create index if not exists idx_planned_duties_employee on planned_duties(employee_id);
