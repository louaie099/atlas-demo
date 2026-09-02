import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { scoreCandidates } from "@/lib/scoring";
import { CONFIG } from "@/lib/seed-data";
import { Employee, Assignment, Flight } from "@/lib/types";

export const dynamic = "force-dynamic";

function subtractMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m - minutes;
  const wrapped = ((total % 1440) + 1440) % 1440;
  const hh = Math.floor(wrapped / 60);
  const mm = wrapped % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

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

  const { data: assignments, error: assignErr } = await supabase
    .from("assignments")
    .select("*")
    .eq("staffing_requirement_id", requirement.id);
  if (assignErr) return NextResponse.json({ error: assignErr.message }, { status: 500 });

  const alreadyAssignedIds = new Set((assignments as Assignment[]).map((a) => a.employee_id));
  const candidatePool = (employees as Employee[]).filter((e) => !alreadyAssignedIds.has(e.id));

  // Use the flight's real boarding window when it has one. Otherwise (e.g.
  // Check-in/ACE, which has no boarding window field) approximate the
  // operational window end as 15 minutes before departure — a simplification
  // noted here rather than silently assumed.
  const windowEnd: string = (flight as Flight).boarding_window_end
    ?? subtractMinutes((flight as Flight).scheduled_departure, 15);

  const candidates = scoreCandidates(requirement.role, windowEnd, candidatePool, CONFIG);

  return NextResponse.json({ candidates });
}
