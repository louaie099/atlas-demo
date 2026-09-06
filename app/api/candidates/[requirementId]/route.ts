import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { scoreCandidates, TimeWindow } from "@/lib/scoring";
import { CONFIG } from "@/lib/seed-data";
import { getEmployeeForeignCommitments } from "@/lib/foreign-company-window";
import { getRequirementWindow } from "@/lib/planning/requirement-window";
import { Employee, Assignment, Flight, StaffingRequirement } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { requirementId: string } }
) {
  const supabase = getSupabaseServerClient();

  const { data: requirement, error: reqErr } = await supabase
    .from("staffing_requirements")
    .select("*")
    .eq("id", params.requirementId)
    .single();

  if (reqErr || !requirement) {
    return NextResponse.json({ error: "Staffing requirement not found" }, { status: 404 });
  }

  if (requirement.needs_configuration) {
    return NextResponse.json(
      { error: "This requirement needs configuration before candidates can be evaluated." },
      { status: 409 }
    );
  }

  const { data: flight, error: flightErr } = await supabase
    .from("flights")
    .select("*")
    .eq("id", requirement.flight_id)
    .single();
  if (flightErr || !flight) return NextResponse.json({ error: "Flight not found" }, { status: 404 });

  const { data: employees, error: empErr } = await supabase.from("employees").select("*");
  if (empErr) return NextResponse.json({ error: empErr.message }, { status: 500 });

  // Fetch ALL assignments/requirements/flights, not just this requirement's
  // — computing an employee's protected commitments for this date requires
  // seeing every assignment they hold across the whole schedule, not only
  // the one being evaluated right now.
  const [{ data: allAssignments, error: assignErr }, { data: allRequirements, error: allReqErr }, { data: allFlights, error: allFlightErr }] =
    await Promise.all([
      supabase.from("assignments").select("*"),
      supabase.from("staffing_requirements").select("*"),
      supabase.from("flights").select("*"),
    ]);
  if (assignErr || allReqErr || allFlightErr) {
    return NextResponse.json({ error: (assignErr || allReqErr || allFlightErr)?.message }, { status: 500 });
  }

  const requirementAssignments = (allAssignments as Assignment[]).filter(
    (a) => a.staffing_requirement_id === requirement.id
  );
  const alreadyAssignedIds = new Set(requirementAssignments.map((a) => a.employee_id));
  const candidatePool = (employees as Employee[]).filter((e) => !alreadyAssignedIds.has(e.id));

  const targetFlight = flight as Flight;

  const window: TimeWindow = getRequirementWindow(requirement, targetFlight);

  // For each candidate, compute their real protected foreign-company
  // commitments on THIS SPECIFIC DATE (the target flight's day) — never
  // a blanket exclusion based on persistent company assignment alone.
  const occupiedWindows: Record<string, TimeWindow[]> = {};
  for (const employee of candidatePool) {
    const commitments = getEmployeeForeignCommitments(
      employee.id,
      allAssignments as Assignment[],
      allRequirements as StaffingRequirement[],
      allFlights as Flight[]
    ).filter((c) => c.dayOfWeek === targetFlight.day_of_week);

    if (commitments.length > 0) {
      occupiedWindows[employee.id] = commitments.map((c) => c.window);
    }
  }

  // Same rule duty-generation.ts uses: a company_config requirement is
  // filled by real company authorization, not a flight-task skill.
  const requiredAuthorization = requirement.source === "company_config" ? targetFlight.airline : undefined;
  const candidates = scoreCandidates(requirement.role, window, candidatePool, CONFIG, occupiedWindows, requiredAuthorization);

  return NextResponse.json({ candidates });
}
