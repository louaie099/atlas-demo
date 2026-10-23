import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * lib/resolve-role.ts is the one place every route handler now gets its
 * role from (see app/api/assign, confirm-reassignment, employees,
 * employees/[id], planning/rules — all migrated off the old
 * getRoleFromHeader(req.headers.get(ROLE_HEADER)) call). This test covers
 * its precedence rules directly, without a real Supabase project: a real
 * session always wins over the header, the header only ever applies when
 * there's no session AND this deployment explicitly opted in to demo mode,
 * and the safe default is "viewer" in every other case.
 */
vi.mock("@/lib/auth-server", () => ({
  getAuthenticatedIdentity: vi.fn(),
}));

import { getAuthenticatedIdentity } from "@/lib/auth-server";
import { resolveRole } from "@/lib/resolve-role";

const mockGetIdentity = getAuthenticatedIdentity as unknown as ReturnType<typeof vi.fn>;

function makeRequest(headerValue?: string): Request {
  const headers = new Headers();
  if (headerValue !== undefined) headers.set("x-atlas-role", headerValue);
  return new Request("http://localhost/api/test", { headers });
}

describe("resolveRole", () => {
  const originalFlag = process.env.ATLAS_ALLOW_DEMO_ROLE_HEADER;

  beforeEach(() => {
    mockGetIdentity.mockReset();
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.ATLAS_ALLOW_DEMO_ROLE_HEADER;
    else process.env.ATLAS_ALLOW_DEMO_ROLE_HEADER = originalFlag;
  });

  it("trusts a real session's role over any header, whether or not demo mode is on", async () => {
    mockGetIdentity.mockResolvedValue({ userId: "u1", email: "a@b.com", role: "administrator" });

    process.env.ATLAS_ALLOW_DEMO_ROLE_HEADER = "true";
    await expect(resolveRole(makeRequest("viewer"))).resolves.toBe("administrator");

    delete process.env.ATLAS_ALLOW_DEMO_ROLE_HEADER;
    await expect(resolveRole(makeRequest("viewer"))).resolves.toBe("administrator");
  });

  it("falls back to the demo header only when there's no session AND demo mode is explicitly on", async () => {
    mockGetIdentity.mockResolvedValue(null);
    process.env.ATLAS_ALLOW_DEMO_ROLE_HEADER = "true";

    await expect(resolveRole(makeRequest("planner"))).resolves.toBe("planner");
    await expect(resolveRole(makeRequest("administrator"))).resolves.toBe("administrator");
  });

  it("ignores the demo header entirely when demo mode is off, even with no session", async () => {
    mockGetIdentity.mockResolvedValue(null);
    delete process.env.ATLAS_ALLOW_DEMO_ROLE_HEADER;

    await expect(resolveRole(makeRequest("administrator"))).resolves.toBe("viewer");
  });

  it("defaults to viewer for an invalid header value, even in demo mode", async () => {
    mockGetIdentity.mockResolvedValue(null);
    process.env.ATLAS_ALLOW_DEMO_ROLE_HEADER = "true";

    await expect(resolveRole(makeRequest("superuser"))).resolves.toBe("viewer");
  });

  it("defaults to viewer when no header is sent and no session exists", async () => {
    mockGetIdentity.mockResolvedValue(null);
    process.env.ATLAS_ALLOW_DEMO_ROLE_HEADER = "true";

    await expect(resolveRole(makeRequest())).resolves.toBe("viewer");
  });
});
