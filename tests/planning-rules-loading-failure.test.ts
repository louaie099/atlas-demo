import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * 2026-09-29 bug fix: "Weekly Planning is now stuck in loading state after
 * the Planning Rules implementation."
 *
 * Root cause (see APPLY_NOTES for the full trace): a genuine Supabase
 * error -- most likely a missing planning_labor_rules/planning_fatigue_config
 * table when migration 0016_planning_rules.sql has not yet been applied --
 * correctly makes loadLaborRules/loadFatigueConfig/resolveEffectiveConfig
 * throw (see tests/planning-rules-persistence.test.ts and rules-service.ts's
 * own doc comment: that part was already correct and is untouched here).
 * But NOTHING caught that throw on the way out: GET/PUT
 * app/api/planning/rules/route.ts and GET app/api/planning/weekly-view/
 * route.ts had no try/catch at all, so the error escaped as an uncaught
 * exception -- which Next.js turns into its own generic, non-JSON 500 page
 * -- and separately, app/planning/page.tsx's loadWeeklyPlan() and
 * components/planning-rules-bar.tsx's load() both had fetch chains with no
 * .catch() anywhere, so a failed/unparseable response left every relevant
 * piece of React state stuck at its initial loading sentinel forever.
 *
 * This file tests the two ROUTE handlers now return a clean, parseable
 * JSON error response instead of throwing uncaught -- the fix that makes
 * app/planning/page.tsx's and planning-rules-bar.tsx's new r.ok/body.error
 * handling actually have something meaningful to read. The frontend fetch
 * chains themselves are plain browser fetch()/useState code with no
 * server-side logic to unit test against this project's node-environment
 * vitest setup (see vitest.config.ts -- no jsdom/testing-library is wired
 * up anywhere in this codebase); they were verified by direct code
 * inspection instead (every .then() chain now ends in a .catch that sets
 * an explicit error state read by the JSX).
 */

const missingTableError = { message: 'relation "public.planning_labor_rules" does not exist', code: "42P01" };

function chainable(result: { data: unknown; error: unknown }) {
  const query: any = {
    eq: () => query,
    order: () => query,
    in: () => query,
    range: () => query,
    then: (onfulfilled: (v: { data: unknown; error: unknown }) => unknown) => Promise.resolve(result).then(onfulfilled),
  };
  return query;
}

describe("Planning Rules API routes fail safe on a genuine Supabase error (2026-09-29 fix)", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/supabase-server");
  });

  it("GET /api/planning/rules returns a JSON 500 (not an uncaught throw) when the tables are missing", async () => {
    vi.doMock("@/lib/supabase-server", () => ({
      getSupabaseServerClient: () => ({
        from: () => ({ select: () => chainable({ data: null, error: missingTableError }) }),
      }),
    }));
    const { GET } = await import("../app/api/planning/rules/route");
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("does not exist");
  });

  it("PUT /api/planning/rules returns a JSON 500 when its post-write reload hits the same missing tables", async () => {
    vi.doMock("@/lib/supabase-server", () => ({
      getSupabaseServerClient: () => ({
        from: () => ({
          select: () => chainable({ data: null, error: missingTableError }),
          update: () => ({ eq: () => Promise.resolve({ error: null }) }),
          insert: () => Promise.resolve({ error: null }),
        }),
      }),
    }));
    const { PUT } = await import("../app/api/planning/rules/route");
    const req = new Request("http://localhost/api/planning/rules", {
      method: "PUT",
      body: JSON.stringify({}),
    });
    const res = await PUT(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("does not exist");
  });

  it("GET /api/planning/weekly-view returns a JSON 500 (not an uncaught throw) when loadPersistedPlanView's own query fails", async () => {
    vi.doMock("@/lib/supabase-server", () => ({
      getSupabaseServerClient: () => ({
        from: (table: string) => {
          if (table === "flights") return { select: () => chainable({ data: [], error: null }) };
          // weekly_plans (the very first query loadPersistedPlanView makes)
          // fails -- simulating any missing/broken table on this read path.
          return { select: () => chainable({ data: null, error: { message: 'relation "public.weekly_plans" does not exist' } }) };
        },
      }),
    }));
    const { GET } = await import("../app/api/planning/weekly-view/route");
    const req = new Request("http://localhost/api/planning/weekly-view?week_start=2026-10-05");
    const res = await GET(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("does not exist");
  });

  it("GET /api/planning/weekly-view still succeeds for a DRAFT plan when only the staleness check's resolveEffectiveConfig fails -- a secondary signal degrades gracefully instead of failing the whole page", async () => {
    const plan = {
      id: "plan-1",
      status: "draft",
      week_start: "2026-10-05",
      issues: [],
      configuration_issues: [],
      generated_from_hash: "irrelevant",
      config_snapshot: { checkin_demand_policy: {}, zone_checkin_demand_policy: {} },
    };
    vi.doMock("@/lib/supabase-server", () => ({
      getSupabaseServerClient: () => ({
        from: (table: string) => {
          if (table === "flights") return { select: () => chainable({ data: [], error: null }) };
          if (table === "weekly_plans") return { select: () => chainable({ data: [plan], error: null }) };
          if (table === "employees") return { select: () => chainable({ data: [], error: null }) };
          if (table === "assignments") return { select: () => chainable({ data: [], error: null }) };
          if (table === "staffing_requirements") return { select: () => chainable({ data: [], error: null }) };
          if (table === "checkin_zone_requirements") return { select: () => chainable({ data: [], error: null }) };
          if (table === "checkin_zone_assignments") return { select: () => chainable({ data: [], error: null }) };
          if (table === "weekly_plan_roster_entries") return { select: () => chainable({ data: [], error: null }) };
          // planning_labor_rules / planning_fatigue_config -- the missing
          // migration 0016 tables -- only these fail.
          return { select: () => chainable({ data: null, error: missingTableError }) };
        },
      }),
    }));
    const { GET } = await import("../app/api/planning/weekly-view/route");
    const req = new Request("http://localhost/api/planning/weekly-view?week_start=2026-10-05");
    const res = await GET(req);
    // The real, already-loaded plan is still returned -- a best-effort
    // secondary signal (isStale) failing must never take down the whole
    // Weekly Planning view.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan.id).toBe("plan-1");
    expect(body.isStale).toBe(false);
  });
});
