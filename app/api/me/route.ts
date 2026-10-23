import { NextResponse } from "next/server";
import { getAuthenticatedIdentity } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

/**
 * Tells the client who it actually is, from the server's point of view --
 * used by components/role-context.tsx to initialize real state instead of
 * always starting from the old client-only "viewer" default. Never trust a
 * client header for this; it's exactly the thing this whole change is
 * replacing.
 */
export async function GET() {
  const identity = await getAuthenticatedIdentity();

  if (!identity) {
    return NextResponse.json({ authenticated: false, role: "viewer" as const });
  }

  return NextResponse.json({
    authenticated: true,
    role: identity.role,
    email: identity.email,
  });
}
