import { Flight, StaffingRequirement } from "./types";

/**
 * Foreign carriers are self-managed operations (per Atlas's operational
 * philosophy: RAM Handling assigns the team, internal task distribution
 * stays under airline staff). Each configured company specifies a
 * headcount and an assignment window — RAM Handling's own commitment,
 * not the airline's internal operation.
 *
 * This is a generic table, not per-airline logic — classifyCompanyRequirement
 * below applies identically to every entry. A carrier absent from this
 * table has no configuration yet, surfaced explicitly, never assumed.
 *
 * `role` is "Company Team" — a neutral internal identifier, not "Ramp
 * Team". These are ACE passenger-service employees assigned to a foreign
 * airline's own ground operation, never airport ramp workers, and the
 * requirement role name must not misrepresent that. Eligibility for this
 * requirement is NEVER a skill match (see scoring.ts's
 * requiredAuthorization parameter) — it's decided by the employee's real
 * `foreign_company_authorizations` for THIS specific airline, so `role`
 * here carries no scoring weight at all; it exists purely to label the
 * requirement/StaffingRequirement row (Flight Coverage displays the even
 * friendlier `coverageLabel`, "{Airline} Team" — see weekly-plan-view.ts).
 *
 * IMPORTANT — this is illustrative demo data, not confirmed real RAM
 * Handling business rules. The specific airlines, headcounts, and
 * assignment windows below (including which carriers appear "unconfigured")
 * are examples chosen to demonstrate the mechanism, not real agreements.
 * Replace with actual configuration before treating any of this as
 * production fact.
 */
const COMPANY_STAFFING_CONFIG: Record<string, { role: string; headcount: number; assignmentWindowMinutes: number }> = {
  "Qatar Airways": { role: "Company Team", headcount: 2, assignmentWindowMinutes: 60 },
  Emirates: { role: "Company Team", headcount: 3, assignmentWindowMinutes: 60 },
  Etihad: { role: "Company Team", headcount: 2, assignmentWindowMinutes: 45 },
  "Gulf Air": { role: "Company Team", headcount: 2, assignmentWindowMinutes: 45 },
  "Air France": { role: "Company Team", headcount: 3, assignmentWindowMinutes: 60 },
  // Turkish Airlines deliberately absent — demonstrates the "unmanaged,
  // no requirement generated at all" path for an unconfigured carrier
  // (see classifyFlightRequirements in weekly-requirements.ts).
};

// Exported for UI/test use — the list of currently-configured foreign
// carriers. Turkish Airlines deliberately absent, per above.
export const CONFIGURED_COMPANIES = Object.keys(COMPANY_STAFFING_CONFIG);

/**
 * The per-flight agent requirement for a configured company — the same
 * headcount classifyCompanyRequirement derives, exposed directly for
 * callers (e.g. the Rotation Feasibility Engine's wiring layer in
 * employee-generator.ts) that need to build a week's operational demand
 * WITHOUT a live Flight object. Returns undefined for an unconfigured
 * carrier — never a guessed number.
 */
export function getCompanyRequiredAgents(company: string): number | undefined {
  return COMPANY_STAFFING_CONFIG[company]?.headcount;
}

export function classifyCompanyRequirement(
  flight: Flight
): Omit<StaffingRequirement, "id" | "flight_id"> | null {
  const config = COMPANY_STAFFING_CONFIG[flight.airline];
  if (!config) return null;

  return {
    role: config.role,
    baseline_requirement: config.headcount,
    additional_requirement: 0,
    total_requirement: config.headcount,
    source: "company_config",
    reasoning: `${config.headcount} agents per ${flight.airline}'s configured staffing agreement (${config.assignmentWindowMinutes}-minute assignment window). RAM Handling assigns the team (from employees authorized for ${flight.airline}); internal task distribution remains under ${flight.airline} staff.`,
    needs_configuration: false,
  };
}

// A carrier absent from COMPANY_STAFFING_CONFIG is UNMANAGED, not "needs
// configuration": classifyFlightRequirements (weekly-requirements.ts)
// deliberately produces NO StaffingRequirement row at all for it — the
// flight simply stays in Flight Schedule with no ATLAS staffing coverage.
// There is no fabricated "Company Configuration" placeholder role/row here
// any more; if a real internal admin surface for configuring a new company
// is ever built, it reads CONFIGURED_COMPANIES/COMPANY_STAFFING_CONFIG
// directly rather than needing a per-flight requirement row to exist.
