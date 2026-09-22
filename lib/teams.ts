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
 * flight-task recommendations. Leaders and Duty Officers now both use the
 * confirmed fixed cycle (see FIXED_CYCLE_TEAMS below); Caisse-BCB's real
 * rotation has still not been provided and is NOT modeled here — this
 * only encodes the exclusion, not an invented schedule.
 */
export const FIXED_PLANNING_TEAMS: Team[] = ["Leaders", "Duty Officers", "Caisse/BCB"];

export function isFixedPlanningTeam(assignment: string): boolean {
  return (FIXED_PLANNING_TEAMS as string[]).includes(assignment);
}

/**
 * Teams with a confirmed, continuous FIXED CYCLE rotation (see
 * lib/fixed-cycle-rotation.ts) rather than a flat per-week OFF-day count
 * or a demand-derived rotation. Currently: Transit, Leaders, and Duty
 * Officers, all sharing the one confirmed JR → NT → OFF → OFF cycle.
 *
 * Duty Officers moved here from a flat single-repeating-code template
 * (see the delivered specialized-team-roster milestone) precisely because
 * that flat template could never satisfy the confirmed 15h minimum rest
 * (JR01/NT01 repeated daily both yield only 11.5h) — the JR/NT/OFF/OFF
 * cycle is the one ALREADY-confirmed, ALREADY-proven-feasible pattern
 * that matches what Duty Officers is documented everywhere else as
 * wanting ("JR/NT-type planning"), so reusing it is a minimum structural
 * correction, not an invented new policy. The exact JR CODE convention
 * (JR01 vs JR02) for Duty Officers remains as unconfirmed as it is for
 * Leaders — see fixed-cycle-rotation.ts's own note on JR_NT_OFF_OFF_CYCLE.
 *
 * This list is planning CONFIGURATION, not part of the rotation engine
 * itself — the engine never branches on a team name; only this table
 * decides which teams use it. Used to keep the generic single-week
 * consecutive-OFF validator (lib/planning/consecutive-off.ts) from
 * misapplying a period-7 wraparound check to a period-4 continuous cycle
 * — these teams are validated directly against their cycle definition
 * instead.
 */
export const FIXED_CYCLE_TEAMS: Team[] = ["Transit", "Leaders", "Duty Officers"];

export function usesFixedCycleRotation(assignment: string): boolean {
  return (FIXED_CYCLE_TEAMS as string[]).includes(assignment);
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
 * CROSS-TEAM REDEPLOYMENT POLICY — config-only, never a branch on a
 * specific company/team name inside planner logic. Confirmed, in one
 * specific shape (Moses, 2026-09-17): a foreign-company ACE remains
 * available RAM capacity outside their protected commitment window, IF
 * their RAM shift is still active — this already works generically today
 * via lib/scoring.ts's scoreCandidates (it only ever excludes an employee
 * for a genuinely OVERLAPPING protected window, never their whole
 * assignment), so no flag is needed to turn that ALREADY-confirmed
 * behavior on for foreign companies.
 *
 * What IS genuinely new here: whether a Profiling/Mesure employee's
 * generated shift is allowed to EXTEND beyond their own team's demand
 * window (see specialized-team-generation.ts/foreign-shift-planning.ts's
 * `preferExtended`), creating real slack time scoreCandidates can then
 * offer for other RAM duty — this was NOT confirmed for Mesure/Profiling
 * (see the known-limitations doc) and defaults to `false`/unconfigured
 * for every team, including every foreign company, until a specific team
 * is explicitly opted in here. This table therefore governs "may this
 * team's shift be extended for redeployment," not "is a foreign ACE ever
 * reachable outside their window" (already true regardless of this
 * table).
 *
 * Transit is the ONE hard, non-configurable exception: `isTransitTeam`
 * always returns false from `isRedeploymentAllowed`, unconditionally,
 * regardless of any entry that could ever be added here — there is
 * deliberately no way to flip that off via configuration, per the
 * explicit instruction that Transit's full-shift commitment is a hard
 * rule, never a policy choice.
 *
 * UPDATE (RAM Handling / product owner, 2026-09-22 — see
 * docs/known-limitations/roster-planning-vs-duty-allocation.md): the
 * "return remaining shift time to RAM T1 capacity" mechanism is NOT
 * optional/policy-gated after all for a foreign-company team — it is the
 * default correct behavior for EVERY configured foreign company, with
 * Transit remaining the one confirmed hard exception (already enforced
 * above, unconditionally). This table stays empty by design and is no
 * longer what decides a foreign company's redeployment eligibility (see
 * isRedeploymentAllowed below) — it remains available ONLY for a future,
 * individually-confirmed EXCEPTION that overrides the new foreign-company
 * default (e.g. if a specific carrier's contract is later confirmed to
 * work like Transit); setting `TEAM_REDEPLOYMENT_POLICY[company] = false`
 * would do that for one company without touching this function. Nothing
 * in this codebase currently sets such an override; none is confirmed.
 * This does NOT change Mesure/Profiling — they are not foreign companies
 * (CONFIGURED_COMPANIES, company-config.ts) and are therefore still
 * governed by the table exactly as before (default false, still
 * unconfirmed either way — see the known-limitations doc). Leaders/Duty
 * Officers/Caisse-BCB (FIXED_PLANNING_TEAMS) and any other still-static
 * team are likewise unaffected: they're never foreign companies either,
 * so this new default never reaches them.
 */
const TEAM_REDEPLOYMENT_POLICY: Record<string, boolean> = {};

export function isRedeploymentAllowed(assignment: string): boolean {
  if (isTransitTeam(assignment)) return false; // hard, non-configurable exception — see doc comment above
  return TEAM_REDEPLOYMENT_POLICY[assignment] === true;
}

/**
 * SEPARATE, NARROWER policy dimension (split out 2026-09-22 from
 * isRedeploymentAllowed above, which used to also govern this): whether a
 * team's generated shift should PREFER the LONGEST compatible catalog
 * code among tied candidates (see foreign-shift-planning.ts's
 * `preferExtended` doc comment) — i.e. deliberately extend a shift beyond
 * the minimum needed to cover the team's own protected/demand window, to
 * manufacture MORE slack time for redeployment than the minimal covering
 * shift would naturally leave. This is a genuinely different, still
 * entirely UNCONFIRMED optimization for every team, foreign company
 * included — confirmed only that a foreign-company ACE is redeployable
 * during whatever real slack their (minimally-sized) shift already
 * leaves after their protected window (see isRedeploymentAllowed above,
 * now default-true for foreign companies), never that ATLAS should
 * intentionally lengthen their shift to create more of it. Deliberately
 * NOT tied to isRedeploymentAllowed's new foreign-company default: doing
 * so previously caused real rest-feasibility shortfalls in production-
 * shaped scenarios (a longer shift one day can leave insufficient rest
 * before the next day's real commitment), an unconfirmed and unintended
 * side effect, not a business rule. Stays governed by
 * TEAM_REDEPLOYMENT_POLICY alone (empty today, so always false for every
 * team) until a real per-team extension policy is confirmed.
 */
export function isShiftExtensionPreferred(assignment: string): boolean {
  return TEAM_REDEPLOYMENT_POLICY[assignment] === true;
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
