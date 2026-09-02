import { CONFIGURED_COMPANIES } from "./company-config";

/**
 * SKILL vs ASSIGNMENT is the core distinction:
 * - Skill (Employee.skills) = a flight-task capability the employee is
 *   trained to perform (Boarding, Gate, Check-in, etc. — see
 *   lib/skill-groups.ts's ADDABLE_QUALIFICATION_GROUPS for the confirmed
 *   vocabulary).
 * - Assignment (Employee.assignment) = where the employee is CURRENTLY
 *   placed for weekly planning: an internal RAM service (this list) or a
 *   foreign company name (see company-config.ts). An employee's assignment
 *   can differ from what they're skilled at — e.g. someone Boarding-skilled
 *   can be currently assigned to Profiling, and their Boarding skill simply
 *   isn't in active use that week.
 *
 * Internal RAM services, with the operational descriptions provided:
 *  - General T1 Pool: general/unassigned — the default ACE pool, no
 *    specialized placement.
 *  - Transit: agents handling anything related to passengers transitioning
 *    through CMN. Committed for the full shift once clocked in (see
 *    isTransitTeam below) — no partial availability.
 *  - Profiling: document verification for transitioning passengers.
 *  - Mesure: inspecting carry-on baggage at the gate. Distinct from Weight
 *    Control (normal baggage-weight checking in T1).
 *  - Baggage Claim: baggage claim area — handles baggage claim and baggage
 *    loss matters.
 *  - Service Plus: T1-based premium/VIP/business-class/lounge activity.
 *  - Caisse/BCB: the payment desk.
 *  - Leaders / Duty Officers: specialized roles with fixed JR/NT-type
 *    planning (see shift-templates.ts) — never general ACE allocation.
 */
export const TEAMS = [
  "General T1 Pool",
  "Transit",
  "Profiling",
  "Mesure",
  "Baggage Claim",
  "Leaders",
  "Duty Officers",
  "Caisse/BCB",
  "Service Plus",
] as const;

export type Team = (typeof TEAMS)[number];

/**
 * Foreign-company work is deliberately NOT a permanent team — but it CAN
 * be an employee's current assignment for the week (Employee.assignment
 * equals a company name from company-config.ts), exactly like an internal
 * service assignment. What makes it non-permanent is operational, not
 * structural: outside a specific flight's protected window (see
 * foreign-company-window.ts), that employee is still available to RAM.
 * Being *assigned* there doesn't blanket-exclude them the way Transit or a
 * fixed-planning team does.
 */

/**
 * These teams follow fixed, specialized planning rather than general ACE
 * allocation — Atlas must never offer them as candidates for ordinary
 * flight-task recommendations. The exact JR/NT-type planning patterns for
 * Leaders/Duty Officers/Caisse-BCB have not been provided and are NOT
 * modeled here — this only encodes the exclusion, not invented schedules.
 */
export const FIXED_PLANNING_TEAMS: Team[] = ["Leaders", "Duty Officers", "Caisse/BCB"];

export function isFixedPlanningTeam(assignment: string): boolean {
  return (FIXED_PLANNING_TEAMS as string[]).includes(assignment);
}

/**
 * Transit is stricter than "fixed planning": Transit agents clock in and
 * remain in Transit for the entire shift. They must never appear as
 * candidates for any role other than Transit itself, for the duration of
 * their shift — there is no partial availability.
 */
export function isTransitTeam(assignment: string): boolean {
  return assignment === "Transit";
}

/**
 * The single, centralized list of operational placements an employee can
 * be assigned to — internal RAM teams and foreign companies together,
 * flat, exactly as an operator thinks about workforce groups (Employees
 * filtering and Add Employee both use this same list, so the two never
 * drift apart). Internally, TEAMS vs. company names are still distinct
 * concepts (see company-config.ts) — this list just presents them as one
 * understandable set of choices.
 */
export const OPERATIONAL_PLACEMENTS = [...TEAMS, ...CONFIGURED_COMPANIES];
