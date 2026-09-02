import { Flight, StaffingRequirement } from "../types";

/**
 * Profiling and Mesure staffing rules — per flight destination
 * category/aircraft, mirroring how operation-rules.ts drives Boarding.
 * Deliberately EMPTY: no rule has been confirmed for which RAM flights
 * require Profiling or Mesure, or how many agents. Per the explicit
 * instruction ("do not invent unknown headcounts/rules... surface as
 * Needs Configuration"), this module recognizes the CONCEPT (a flight
 * can have a Profiling/Mesure requirement) without fabricating the rule
 * itself. When real rules are confirmed, add them here — the same shape
 * as RAM_BOARDING_RULES in operation-rules.ts — and
 * classifyProfilingRequirement/classifyMesureRequirement will start
 * returning real requirements automatically, no caller changes needed.
 */
const PROFILING_RULES: Record<string, Record<string, number>> = {};
const MESURE_RULES: Record<string, Record<string, number>> = {};

function classifyFromRuleTable(
  flight: Flight,
  rules: Record<string, Record<string, number>>,
  role: "Profiling" | "Mesure"
): Omit<StaffingRequirement, "id" | "flight_id"> | null {
  if (!flight.destination_category) return null;
  const baseline = rules[flight.aircraft]?.[flight.destination_category];
  if (baseline === undefined) return null;

  return {
    role,
    baseline_requirement: baseline,
    additional_requirement: 0,
    total_requirement: baseline,
    source: "fixed_rule",
    reasoning: `${baseline} ${role} agents required — operation rule for ${flight.aircraft} to ${flight.destination_category} destinations.`,
    needs_configuration: false,
  };
}

function missingSpecializedConfig(
  flight: Flight,
  role: "Profiling" | "Mesure"
): Omit<StaffingRequirement, "id" | "flight_id"> {
  return {
    role,
    baseline_requirement: 0,
    additional_requirement: 0,
    total_requirement: 0,
    source: "fixed_rule",
    reasoning: `No ${role} operation rule configured yet for ${flight.aircraft} to "${flight.destination_category ?? "unspecified"}" destinations. Add this combination before ${role} can be planned for this flight.`,
    needs_configuration: true,
  };
}

/**
 * Whether this RAM flight has any confirmed Profiling requirement at all.
 * Returns null (not a requirement, not even "needs configuration") when
 * there's no way yet to know WHICH flights need Profiling — that
 * criterion itself hasn't been confirmed, only the headcount-once-needed
 * shape has. This deliberately stops short of flagging every RAM flight
 * as "needs configuration" for a demand type we don't even know applies
 * to it, which would be noise, not information.
 */
export function classifyProfilingRequirement(flight: Flight): Omit<StaffingRequirement, "id" | "flight_id"> | null {
  if (flight.operator_type !== "atlas_managed") return null;
  const ruled = classifyFromRuleTable(flight, PROFILING_RULES, "Profiling");
  if (ruled) return ruled;
  if (Object.keys(PROFILING_RULES).length === 0) return null; // no rule table populated at all yet — not this flight's problem specifically
  return missingSpecializedConfig(flight, "Profiling");
}

export function classifyMesureRequirement(flight: Flight): Omit<StaffingRequirement, "id" | "flight_id"> | null {
  if (flight.operator_type !== "atlas_managed") return null;
  const ruled = classifyFromRuleTable(flight, MESURE_RULES, "Mesure");
  if (ruled) return ruled;
  if (Object.keys(MESURE_RULES).length === 0) return null;
  return missingSpecializedConfig(flight, "Mesure");
}
