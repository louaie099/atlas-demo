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
 * IMPORTANT — this is illustrative demo data, not confirmed real RAM
 * Handling business rules. The specific airlines, headcounts, and
 * assignment windows below (including which carriers appear "unconfigured")
 * are examples chosen to demonstrate the mechanism, not real agreements.
 * Replace with actual configuration before treating any of this as
 * production fact.
 */
const COMPANY_STAFFING_CONFIG: Record<string, { role: string; headcount: number; assignmentWindowMinutes: number }> = {
  "Qatar Airways": { role: "Ramp Team", headcount: 2, assignmentWindowMinutes: 60 },
  Emirates: { role: "Ramp Team", headcount: 3, assignmentWindowMinutes: 60 },
  Etihad: { role: "Ramp Team", headcount: 2, assignmentWindowMinutes: 45 },
  "Gulf Air": { role: "Ramp Team", headcount: 2, assignmentWindowMinutes: 45 },
  "Air France": { role: "Ramp Team", headcount: 3, assignmentWindowMinutes: 60 },
  // Turkish Airlines deliberately absent — demonstrates the
  // "needs configuration" path for an unconfigured carrier.
};

// Exported for UI/test use — the list of currently-configured foreign
// carriers. Turkish Airlines deliberately absent, per above.
export const CONFIGURED_COMPANIES = Object.keys(COMPANY_STAFFING_CONFIG);

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
    reasoning: `${config.headcount} ${config.role} agents per ${flight.airline}'s configured staffing agreement (${config.assignmentWindowMinutes}-minute assignment window). RAM Handling assigns the team; internal task distribution remains under ${flight.airline} staff.`,
    needs_configuration: false,
  };
}

export function missingCompanyConfigRequirement(
  flight: Flight
): Omit<StaffingRequirement, "id" | "flight_id"> {
  return {
    role: "Unconfigured",
    baseline_requirement: 0,
    additional_requirement: 0,
    total_requirement: 0,
    source: "company_config",
    reasoning: `No staffing configuration exists yet for ${flight.airline}. Add a company staffing agreement (role, headcount, assignment window) before this flight can be planned.`,
    needs_configuration: true,
  };
}
