import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * middleware.ts is the one central place that now enforces "signed in,
 * or this deployment explicitly opted in to demo mode" for every request
 * -- see its own doc comment for why this replaced "a signed-out visitor
 * silently gets treated as Viewer" (the old behavior left ~30 API routes,
 * including GET /api/employees, reachable by anyone with the URL).
 *
 * Mocks @supabase/ssr's createServerClient the same way
 * tests/resolve-role.test.ts mocks getAuthenticatedIdentity -- this suite
 * is about the gate's redirect/401 logic, not Supabase's own session
 * mechanics.
 */
const mockGetUser = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: mockGetUser },
  }),
}));

import { middleware } from "../middleware";

const ORIGINAL_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ORIGINAL_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const ORIGINAL_DEMO_FLAG = process.env.ATLAS_ALLOW_DEMO_ROLE_HEADER;

function req(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`);
}

describe("middleware — sign-in gate", () => {
  beforeEach(() => {
    mockGetUser.mockReset();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    // This repo's vitest.config.ts sets ATLAS_ALLOW_DEMO_ROLE_HEADER=true
    // globally so the rest of the suite can exercise role boundaries
    // without a real session -- turn it off by default in THIS file so
    // the gate's actual (demo-mode-off) behavior is what's under test;
    // individual demo-mode tests turn it back on explicitly.
    delete process.env.ATLAS_ALLOW_DEMO_ROLE_HEADER;
  });

  afterEach(() => {
    if (ORIGINAL_SUPABASE_URL === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGINAL_SUPABASE_URL;
    if (ORIGINAL_ANON_KEY === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ORIGINAL_ANON_KEY;
    if (ORIGINAL_DEMO_FLAG === undefined) delete process.env.ATLAS_ALLOW_DEMO_ROLE_HEADER;
    else process.env.ATLAS_ALLOW_DEMO_ROLE_HEADER = ORIGINAL_DEMO_FLAG;
  });

  it("passes a signed-out page request through unchanged if Supabase isn't configured at all", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const res = await middleware(req("/employees"));
    expect(res.status).toBe(200);
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("redirects a signed-out visitor hitting a page to /login, preserving where they were headed", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const res = await middleware(req("/employees"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/employees");
  });

  it("returns 401 JSON, not a redirect, for a signed-out API request", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const res = await middleware(req("/api/employees"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/sign in/i);
  });

  it("never gates /login, /auth/callback, or /api/me -- a signed-out visitor must be able to reach all three", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    for (const path of ["/login", "/auth/callback", "/api/me"]) {
      const res = await middleware(req(path));
      expect(res.status).toBe(200);
    }
  });

  it("lets a signed-in request through to any page or API route", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    for (const path of ["/employees", "/api/employees", "/planning"]) {
      const res = await middleware(req(path));
      expect(res.status).toBe(200);
    }
  });

  it("lets a signed-out request through when this deployment has explicitly opted in to demo mode", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    process.env.ATLAS_ALLOW_DEMO_ROLE_HEADER = "true";
    for (const path of ["/employees", "/api/employees"]) {
      const res = await middleware(req(path));
      expect(res.status).toBe(200);
    }
  });
});
