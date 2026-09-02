/**
 * TEAM vs QUALIFICATION is a deliberate distinction, not a naming choice:
 * - Qualification (Employee.roles) = what an employee is capable/authorized
 *   to perform. Can hold several simultaneously.
 * - Team (Employee.default_team) = where they normally belong for weekly
 *   planning. An employee can be Profiling-qualified while their default
 *   team is General T1 Pool — the qualification doesn't change their team.
 */
export const TEAMS = [
  "General T1 Pool",
  "Transit",
  "Profiling",
  "Mesure",
  "Leaders",
  "Duty Officers",
  "Caisse/BCB",
  "Service Plus",
] as const;

export type Team = (typeof TEAMS)[number];

/**
 * Foreign-company work is deliberately NOT a team. An ACE's foreign-company
 * authorization (Employee.foreign_company_authorizations) is layered on
 * top of their normal team and availability — they work La RAM whenever
 * they're outside a protected foreign-company commitment window (see
 * foreign-company-window.ts). Modeling it as a team would wrongly imply
 * permanent unavailability to RAM, which contradicts how this actually
 * works.
 */

/**
 * These teams follow fixed, specialized planning rather than general ACE
 * allocation — Atlas must never offer them as candidates for ordinary
 * flight-task recommendations. The exact JR/NT-type planning patterns for
 * Leaders/Duty Officers/Caisse-BCB have not been provided and are NOT
 * modeled here — this only encodes the exclusion, not invented schedules.
 */
export const FIXED_PLANNING_TEAMS: Team[] = ["Leaders", "Duty Officers", "Caisse/BCB"];

export function isFixedPlanningTeam(team: string): boolean {
  return (FIXED_PLANNING_TEAMS as string[]).includes(team);
}

/**
 * Transit is stricter than "fixed planning": Transit agents clock in and
 * remain in Transit for the entire shift. They must never appear as
 * candidates for any role other than Transit itself, for the duration of
 * their shift — there is no partial availability.
 */
export function isTransitTeam(team: string): boolean {
  return team === "Transit";
}
