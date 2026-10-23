# Known limitations: Authentication and Row-Level Security (2026-10-22)

**Status: Phase 1a implemented and tested (real auth + session-backed role
resolution); Phase 1b (RLS as the actual enforcement layer) is written but
NOT yet applied or verified against a live Supabase project.** Recorded here
so the exact boundary between what's real and what's prepared-but-unverified
survives independently of any one conversation or commit — see the RAM
Handling integration proposal's Technical and security requirements section
for the business framing this work answers.

## The gap this closes

Before this change, `lib/roles.ts`'s `getRoleFromHeader` trusted a plain
`x-atlas-role` request header, unconditionally, for every mutating route.
There was no login, no verified identity, no session — anyone who could
reach the deployed URL and set a header could act as Administrator. That was
documented honestly (see this file's own git history / the original
`lib/roles.ts` doc comment) but was never actually fixed until now.

## What's CONFIRMED (implemented and tested this milestone)

- Real Supabase Auth sign-in (`app/login`, email/password or a magic link),
  backed by an httpOnly session cookie — never readable or forgeable by
  client JavaScript the way the old header was.
- `lib/auth-server.ts`'s `getAuthenticatedIdentity()` reads that session
  server-side and looks up the signed-in user's role from a new
  `user_roles` table. A signed-in user with no role row yet is treated as
  the least-privileged role ("viewer") — the same safe-default rule the old
  header check already followed, never silently elevated just for having an
  account.
- `lib/resolve-role.ts`'s `resolveRole()` is now the ONE place every
  protected route gets its role from (it replaces five separate call sites
  in `app/api/assign`, `app/api/confirm-reassignment`, `app/api/employees`,
  `app/api/employees/[id]`, `app/api/planning/rules`). Precedence is strict:
  a real session's role always wins; the old header is only ever consulted
  when there is NO session AND this deployment explicitly set
  `ATLAS_ALLOW_DEMO_ROLE_HEADER=true`; otherwise the safe default is
  "viewer". A production deployment that never sets that flag cannot reach
  the header fallback at all, by construction, not by convention.
- `tests/resolve-role.test.ts` covers this precedence directly (a real
  session overrides any header value in either direction; the header is
  inert unless both "no session" and "demo mode on" hold; an invalid header
  value and a missing header both still resolve to "viewer").
- The old header-based demo role switcher (`components/role-context.tsx`,
  `components/nav-bar.tsx`'s `RoleSwitcher`) still exists, but only renders,
  and only has any effect, when `NEXT_PUBLIC_ATLAS_DEMO_MODE=true` AND
  nobody is signed in — so quick stakeholder demos keep working exactly as
  before, without that convenience being reachable in a real deployment.

## What's PREPARED BUT NOT YET THE ENFORCEMENT LAYER

- `supabase/migrations/0019_user_roles_and_rls.sql` creates the
  `user_roles` table and enables Row-Level Security with policies on every
  real data table, mirroring the exact same administrator/planner
  boundaries `lib/roles.ts`'s `canManageEmployees` / `canManageOperations` /
  `canManageLaborRules` already enforce in route handlers. **This file has
  not been run against a live Supabase project in this sandbox** (there is
  no live project reachable from here to run or test a migration against) —
  it needs to be applied to a staging project first, confirmed not to
  change observable behavior (it shouldn't — see below), and only then
  applied to the real project.
- Why it doesn't change behavior yet: every `app/api/*` route still reads
  and writes through `lib/supabase-server.ts`'s SERVICE-ROLE client, which
  bypasses RLS entirely by Postgres/Supabase design. The actual enforcement
  today is still `resolveRole()` plus each route's own `canManage*()` check
  — application-layer only. RLS becomes a second, independent enforcement
  layer (defense in depth against a bug or an omitted check in a route)
  only once routes are migrated to a per-request client scoped to the
  signed-in user's own JWT (`lib/supabase-route-client.ts`'s pattern,
  extended from "who is this" to "read and write as this person"). That
  migration is genuinely Phase 1b's remaining work, not done here.

## What still needs a decision from outside this repository

- Who provisions real accounts and assigns their `user_roles` row — this
  milestone deliberately ships no self-service sign-up page; accounts are
  meant to be created by an administrator (via the Supabase dashboard, or a
  small internal invite flow not yet built), consistent with the pilot
  plan's "named participants, not open enrollment."
- Whether RAM Handling's IT wants Supabase Auth itself, or SSO against
  whatever identity provider they already use — this used Supabase Auth
  because it's already the project's backend; a real pilot may need a
  different answer, which is exactly the kind of question the proposal's
  Technical and security requirements section asks IT to help settle.
- The Phase 1b RLS migration above still needs to be run and tested against
  a real (ideally staging) Supabase project before it's trusted as a real
  boundary, and before routes are migrated to the user-scoped client that
  would make it load-bearing.
