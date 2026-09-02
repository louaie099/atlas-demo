-- Additive migration — run AFTER 0001 through 0007.
-- Active/inactive workforce status, editable only by Administrators via
-- PATCH /api/employees/[id] (see lib/roles.ts). Defaults true so existing
-- employees are unaffected.

alter table employees add column if not exists active boolean not null default true;
