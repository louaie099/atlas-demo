import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getCandidatesForRequirement } from "@/lib/planning/candidate-lookup";

export const dynamic = "force-dynamic";

/**
 * GET /api/candidates/[requirementId] — Find Agent's candidate list.
 * Thin route wrapper: all the actual eligibility logic lives in
 * lib/planning/candidate-lookup.ts's getCandidatesForRequirement, shared
 * with the Live Operations replacement-candidate lookup
 * (lib/live-ops-service.ts) so both paths can never disagree about who's
 * eligible. See that function's doc comment for the 2026-10-03 week-
 * derivation bug fix (this route used to hardcode CURRENT_WEEK_START).
 */
export async function GET(
  _req: Request,
  { params }: { params: { requirementId: string } }
) {
  const supabase = getSupabaseServerClient();
  const result = await getCandidatesForRequirement(supabase, params.requirementId);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ candidates: result.candidates, exclusionSummary: result.exclusionSummary });
}
