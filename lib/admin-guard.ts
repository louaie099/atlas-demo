import crypto from "crypto";

/**
 * Server-only admin-key gate for destructive/admin-only route handlers
 * (full database reset, dataset reseeding, flight deletion). This is a
 * demo-grade gate, not a real auth system -- see lib/roles.ts for the
 * same caveat applied to roles. It exists to stop an accidental click
 * (or a stray automated request) from wiping the live demo database,
 * not to defend against a determined attacker.
 *
 * Fails CLOSED: if ATLAS_ADMIN_KEY isn't configured in this environment,
 * every request is rejected with 503 rather than silently letting the
 * action through un-gated. The comparison is constant-time
 * (crypto.timingSafeEqual over SHA-256 digests of the configured key and
 * the submitted header) so a wrong guess can't be narrowed down via
 * response timing.
 */

export const ADMIN_KEY_HEADER = "x-atlas-admin-key";

export type AdminGuardResult = { ok: true } | { ok: false; status: number; error: string };

function sha256(input: string): Buffer {
  return crypto.createHash("sha256").update(input, "utf8").digest();
}

export function requireAdminKey(req: Request): AdminGuardResult {
  const configuredKey = process.env.ATLAS_ADMIN_KEY;
  if (!configuredKey) {
    return {
      ok: false,
      status: 503,
      error: "Admin actions are not configured on this server (ATLAS_ADMIN_KEY is unset).",
    };
  }

  const submittedKey = req.headers.get(ADMIN_KEY_HEADER);
  if (!submittedKey) {
    return { ok: false, status: 401, error: "Missing admin key." };
  }

  const expectedDigest = sha256(configuredKey);
  const submittedDigest = sha256(submittedKey);
  const matches =
    expectedDigest.length === submittedDigest.length &&
    crypto.timingSafeEqual(expectedDigest, submittedDigest);

  if (!matches) {
    return { ok: false, status: 401, error: "Invalid admin key." };
  }

  return { ok: true };
}
