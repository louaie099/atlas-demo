# Atlas Demo — Airport Workforce Operations (CMN)

A vertical-slice demo: weekly workforce planning (fixed-rule and overbooking-forecast staffing
requirements) connected to live operations (delay simulation, conflict detection, human-approved
reassignment), with a full audit trail. Built with Next.js, Supabase, and Tailwind. See
`../04-finalized-architecture.md` and `../ADR-0003-demo-first-pivot.md` for the full design record.

## Local setup

1. `npm install`
2. Create a Supabase project (see "Supabase setup" below), then copy `.env.example` to `.env` and
   fill in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
3. Run the schema migration (see below).
4. `npm run seed` — populates the database with the scripted demo dataset.
5. `npm run dev` — open http://localhost:3000.
6. Use the **Reset Demo** button (top right) any time to return to the scripted starting state.

## Supabase setup

1. Go to https://supabase.com, create a new project.
2. In the Supabase dashboard, open **SQL Editor** → paste the contents of
   `supabase/migrations/0001_init.sql` → run it. This creates all six tables.
3. In **Project Settings → API**, copy the **Project URL** and the **service_role** key (not the
   anon key — the app's server-side routes use the service role key) into your `.env`.
4. Run `npm run seed` locally once to populate the tables.

## Deploying to GitHub + Vercel

1. Initialize git and push to a new GitHub repo (from inside this `demo/` folder, or wherever you
   place this project — keep it separate from the production `backend/`/`frontend/` history if this
   lives inside the main Atlas repo):
   ```
   git init
   git add .
   git commit -m "feat: Atlas demo MVP (Next.js + Supabase)"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```
2. Go to https://vercel.com → **Add New Project** → import the GitHub repo you just pushed.
3. Vercel will auto-detect Next.js. Before deploying, expand **Environment Variables** and add:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   (same values as your local `.env`).
4. Click **Deploy**. Vercel builds and gives you a live URL (e.g. `atlas-demo.vercel.app`).
5. Visit the deployed URL, click **Reset Demo** once to seed the live database (or run
   `npm run seed` locally against the same Supabase project before sharing the link).
6. Every future `git push` to `main` auto-redeploys.

**Recommended before presenting to the DG:** in Vercel's project settings, enable password
protection (Pro plan) or otherwise gate the URL, since it will be publicly reachable by default.

## Testing

`npm run test` runs the pure-logic unit tests (`lib/scoring.ts`, `lib/conflict.ts`). These have no
database dependency and run instantly.

## What's intentionally out of scope

- No multi-tenancy, no RLS, no authentication beyond an optional deployment-level gate.
- Live Operations does not yet monitor *actual* demand against the AT535 overbooking forecast —
  only the Planning-side forecast → gap → Find Agent → assign loop is implemented for AT535. See
  `../04-finalized-architecture.md` §9 for what a future iteration would add.
- This demo is disposable and separate from Atlas's production engine architecture
  (ADR-0000/0001/0002) — see `../ADR-0003-demo-first-pivot.md`.

## Known limitation — dependency versions

This project pins `next@14.2.35` (latest patched release in the 14.x line). `npm audit` will still
report several advisories that are only fully resolved by upgrading to Next.js 16, which is a
breaking major-version change not attempted here given the demo's short lifespan and lack of
sensitive data. If this code is ever reconciled into anything longer-lived, revisit this.
