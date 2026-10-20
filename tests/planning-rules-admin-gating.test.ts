import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * LABOR RULES v2 (2026-10-20) -- Moses's explicit direction: "THE RULES
 * SHOULDNT BE IN THE BACKGROUND THEY SHOULD BE ABLE TO APPEAR TO THE
 * PLANNER AND CAN BE CONFIGURED BY THE ADMINS ALL THE LABOR WORK." This
 * file tests the new role boundary on app/api/planning/rules/route.ts:
 * GET stays open to any role (Planner must still be able to SEE the
 * rules), PUT is Administrator-only (see lib/roles.ts's
 * canManageLaborRules) and is rejected with 403 BEFORE it ever reaches
 * saveLaborRuleEdit/saveFatigueConfig -- so an unauthorized PUT must never
 * persist anything, which this file verifies by asserting the fake
 * Supabase's insert/update are never invoked for a rejected request.
 */

function chainable(result: { data: unknown; error: unknown }) {
  const query: any = {
    eq: () => query,
    then: (onfulfilled: (v: { data: unknown; error: unknown }) => unknown) => Promise.resolve(result).then(onfulfilled),
  };
  return query;
}

describe("Planning Rules API admin gating (2026-10-20, Labor Rules v2)", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/supabase-server");
  });

  it("PUT with no role header (defaults to viewer) is rejected with 403 and never touches the database", async () => {
    const insert = vi.fn(() => Promise.resolve({ error: null }));
    const update = vi.fn(() => ({ eq: () => Promise.resolve({ error: null }) }));
    vi.doMock("@/lib/supabase-server", () => ({
      getSupabaseServerClient: () => ({
        from: () => ({ select: () => chainable({ data: [], error: null }), insert, update }),
      }),
    }));
    const { PUT } = await import("../app/api/planning/rules/route");
    const req = new Request("http://localhost/api/planning/rules", {
      method: "PUT",
      body: JSON.stringify({ laborRules: { minimumRestHours: 99 } }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/administrator/i);
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("PUT as planner is rejected with 403 -- Planner may view, not edit", async () => {
    vi.doMock("@/lib/supabase-server", () => ({
      getSupabaseServerClient: () => ({ from: () => ({ select: () => chainable({ data: [], error: null }) }) }),
    }));
    const { PUT } = await import("../app/api/planning/rules/route");
    const req = new Request("http://localhost/api/planning/rules", {
      method: "PUT",
      headers: { "x-atlas-role": "planner" },
      body: JSON.stringify({ laborRules: { minimumRestHours: 99 } }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(403);
  });

  it("PUT as administrator is allowed through to the persistence layer", async () => {
    const insert = vi.fn(() => Promise.resolve({ error: null }));
    vi.doMock("@/lib/supabase-server", () => ({
      getSupabaseServerClient: () => ({
        from: () => ({
          select: () => chainable({ data: [], error: null }),
          insert,
          update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        }),
      }),
    }));
    const { PUT } = await import("../app/api/planning/rules/route");
    const req = new Request("http://localhost/api/planning/rules", {
      method: "PUT",
      headers: { "x-atlas-role": "administrator" },
      body: JSON.stringify({ laborRules: { minimumRestHours: 16 } }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    // The 403 guard is the only thing this file tests directly -- the real
    // persistence round-trip (edit -> reload reflecting the new value) is
    // already covered against a real stateful fake table in
    // tests/planning-rules-persistence.test.ts. Here we just confirm an
    // authorized request actually reaches saveLaborRuleEdit's insert.
    expect(insert).toHaveBeenCalled();
  });

  it("GET remains open to any role, including the default viewer -- Planner/Viewer must still be able to see the resolved rules", async () => {
    vi.doMock("@/lib/supabase-server", () => ({
      getSupabaseServerClient: () => ({ from: () => ({ select: () => chainable({ data: [], error: null }) }) }),
    }));
    const { GET } = await import("../app/api/planning/rules/route");
    const res = await GET();
    expect(res.status).toBe(200);
  });
});
