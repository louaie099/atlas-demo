import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { requireAdminKey, ADMIN_KEY_HEADER } from "../lib/admin-guard";

const ORIGINAL_KEY = process.env.ATLAS_ADMIN_KEY;

function reqWithHeader(header?: string): Request {
  const headers: Record<string, string> = {};
  if (header !== undefined) headers[ADMIN_KEY_HEADER] = header;
  return new Request("http://localhost/api/reset", { method: "POST", headers });
}

describe("lib/admin-guard — requireAdminKey", () => {
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.ATLAS_ADMIN_KEY;
    else process.env.ATLAS_ADMIN_KEY = ORIGINAL_KEY;
  });

  it("fails closed with 503 when ATLAS_ADMIN_KEY is not configured on the server", () => {
    delete process.env.ATLAS_ADMIN_KEY;
    const result = requireAdminKey(reqWithHeader("anything"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.error).toMatch(/not configured/i);
    }
  });

  it("rejects with 401 when the admin key header is missing", () => {
    process.env.ATLAS_ADMIN_KEY = "correct-horse-battery-staple";
    const result = requireAdminKey(reqWithHeader(undefined));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toMatch(/missing/i);
    }
  });

  it("rejects with 401 when the submitted key does not match the configured key", () => {
    process.env.ATLAS_ADMIN_KEY = "correct-horse-battery-staple";
    const result = requireAdminKey(reqWithHeader("wrong-guess"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toMatch(/invalid/i);
    }
  });

  it("accepts a correctly matching admin key", () => {
    process.env.ATLAS_ADMIN_KEY = "correct-horse-battery-staple";
    const result = requireAdminKey(reqWithHeader("correct-horse-battery-staple"));
    expect(result.ok).toBe(true);
  });

  it("is not fooled by a key that merely shares a prefix with the configured key", () => {
    process.env.ATLAS_ADMIN_KEY = "correct-horse-battery-staple";
    const result = requireAdminKey(reqWithHeader("correct-horse-battery-stapl"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });
});

describe("admin-gated routes — guard runs before the underlying action", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.ATLAS_ADMIN_KEY = "correct-horse-battery-staple";
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.ATLAS_ADMIN_KEY;
    else process.env.ATLAS_ADMIN_KEY = ORIGINAL_KEY;
    vi.doUnmock("../lib/reset-database");
    vi.doUnmock("../lib/reset-small-demo");
    vi.doUnmock("../lib/reset-poc-demo");
    vi.doUnmock("../lib/reset-empty");
    vi.doUnmock("../lib/supabase-server");
  });

  it("POST /api/reset returns 503 when unconfigured, 401 on a bad key, and runs the reset on a good key", async () => {
    const resetDatabase = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../lib/reset-database", () => ({ resetDatabase }));
    vi.doMock("../lib/supabase-server", () => ({ getSupabaseServerClient: () => ({}) }));
    const { POST } = await import("../app/api/reset/route");

    delete process.env.ATLAS_ADMIN_KEY;
    const unconfigured = await POST(reqWithHeader("whatever"));
    expect(unconfigured.status).toBe(503);
    expect(resetDatabase).not.toHaveBeenCalled();

    process.env.ATLAS_ADMIN_KEY = "correct-horse-battery-staple";
    const badKey = await POST(reqWithHeader("wrong"));
    expect(badKey.status).toBe(401);
    expect(resetDatabase).not.toHaveBeenCalled();

    const ok = await POST(reqWithHeader("correct-horse-battery-staple"));
    expect(ok.status).toBe(200);
    expect(resetDatabase).toHaveBeenCalledTimes(1);
  });

  it("POST /api/reset-small-demo is gated the same way", async () => {
    const resetSmallDemoDatabase = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../lib/reset-small-demo", () => ({ resetSmallDemoDatabase }));
    vi.doMock("../lib/supabase-server", () => ({ getSupabaseServerClient: () => ({}) }));
    const { POST } = await import("../app/api/reset-small-demo/route");

    const badKey = await POST(reqWithHeader("wrong"));
    expect(badKey.status).toBe(401);
    expect(resetSmallDemoDatabase).not.toHaveBeenCalled();

    const ok = await POST(reqWithHeader("correct-horse-battery-staple"));
    expect(ok.status).toBe(200);
    expect(resetSmallDemoDatabase).toHaveBeenCalledTimes(1);
  });

  it("POST /api/reset-poc-demo is gated the same way", async () => {
    const resetPocDemoDatabase = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../lib/reset-poc-demo", () => ({ resetPocDemoDatabase }));
    vi.doMock("../lib/supabase-server", () => ({ getSupabaseServerClient: () => ({}) }));
    const { POST } = await import("../app/api/reset-poc-demo/route");

    const badKey = await POST(reqWithHeader("wrong"));
    expect(badKey.status).toBe(401);
    expect(resetPocDemoDatabase).not.toHaveBeenCalled();

    const ok = await POST(reqWithHeader("correct-horse-battery-staple"));
    expect(ok.status).toBe(200);
    expect(resetPocDemoDatabase).toHaveBeenCalledTimes(1);
  });

  it("POST /api/reset-empty is gated the same way", async () => {
    const resetToEmptyDatabase = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../lib/reset-empty", () => ({ resetToEmptyDatabase }));
    vi.doMock("../lib/supabase-server", () => ({ getSupabaseServerClient: () => ({}) }));
    const { POST } = await import("../app/api/reset-empty/route");

    const badKey = await POST(reqWithHeader("wrong"));
    expect(badKey.status).toBe(401);
    expect(resetToEmptyDatabase).not.toHaveBeenCalled();

    const ok = await POST(reqWithHeader("correct-horse-battery-staple"));
    expect(ok.status).toBe(200);
    expect(resetToEmptyDatabase).toHaveBeenCalledTimes(1);
  });

  it("DELETE /api/flights/[id] is gated the same way", async () => {
    const deleteEq = vi.fn().mockResolvedValue({ error: null });
    const fakeSupabase = {
      from: () => ({ delete: () => ({ eq: deleteEq }) }),
    };
    vi.doMock("../lib/supabase-server", () => ({ getSupabaseServerClient: () => fakeSupabase }));
    const { DELETE } = await import("../app/api/flights/[id]/route");

    const badKey = await DELETE(reqWithHeader("wrong"), { params: { id: "flight-1" } });
    expect(badKey.status).toBe(401);
    expect(deleteEq).not.toHaveBeenCalled();

    const ok = await DELETE(reqWithHeader("correct-horse-battery-staple"), { params: { id: "flight-1" } });
    expect(ok.status).toBe(200);
    expect(deleteEq).toHaveBeenCalledWith("id", "flight-1");
  });
});
