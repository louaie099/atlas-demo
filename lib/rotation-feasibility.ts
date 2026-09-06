/**
 * Rotation Feasibility Engine — generic, company/team-agnostic derivation
 * and testing of team rotations. Never branches on a company or team name;
 * every candidate is generated and tested purely from:
 *   - headcount (how many agents are assigned to this team)
 *   - weekly demand (which days require coverage, and how many agents)
 *   - the confirmed normalWeeklyOffDays labor rule (never a ceiling)
 *   - an optional, purely advisory RotationPreference
 *
 * Two DIFFERENT companies with different flight patterns and headcounts
 * will legitimately derive different rotations from this same function —
 * because their inputs differ, never because the code recognizes their
 * names. Do not add a company/team conditional anywhere in this file.
 *
 * HARD FEASIBILITY vs. RANKING (important distinction, corrected from an
 * earlier version of this engine): the only HARD constraints a rotation
 * can fail on are the confirmed labor rule's OFF-day count and whether the
 * resulting working headcount covers every day's real demand. Contiguous
 * (unfragmented) rest is operationally preferable — ATLAS should always
 * prefer a candidate with coherent rest blocks over an otherwise
 * equivalent fragmented one — but fragmentation alone is NOT a confirmed
 * hard labor rule, so it must never make a rotation infeasible by itself.
 * Every combination of OFF-day placements (contiguous or not) that
 * satisfies the hard constraints is a valid candidate; candidates are then
 * RANKED by a restContinuityScore (1.0 = fully contiguous per group, lower
 * = more fragmented), and the highest-ranked feasible candidate is
 * returned, together with that scoring, so ATLAS can later explain why one
 * feasible rotation was preferred over another. If continuity is ever
 * confirmed as a genuine hard rule, that becomes a real filter added here
 * explicitly — it must not be smuggled in as an implicit search-order
 * artifact again.
 *
 * Rest-hours-between-shifts (minimumRestHours) is NOT re-validated inside
 * this module — that depends on the ACTUAL shift code chosen per day
 * (varies with each day's real flight window), which is exactly what
 * lib/foreign-shift-planning.ts's planForeignCompanyDay already does,
 * reused as-is by the wiring layer (lib/seed-data.ts / employee-
 * generator.ts) that assigns actual shift codes to a feasible candidate's
 * groups. If shift-code assignment fails for a specific day even after
 * this engine finds a headcount-feasible rotation, that is a real,
 * separate, per-day/per-employee capacity reduction — reported honestly,
 * never patched by silently inventing a shift or borrowing rest from an
 * OFF day.
 *
 * When NO candidate (of any group count, any OFF-day placement) satisfies
 * the hard constraints, this returns { feasible: false, reason }. Callers
 * MUST treat that as a real operational result — a capacity gap — and
 * must NOT fall back to inventing an unrelated flat roster for that team;
 * see RotationInfeasibleError and lib/employee-generator.ts.
 */

export interface DemandDay {
  dayOfWeek: string;
  requiredAgents: number; // 0 on a day with no flight for this team
}

export interface RotationGroup {
  offDays: string[];
  workingDays: string[];
  size: number;
  // 1.0 = this group's OFF days form one contiguous run (cyclically);
  // lower values mean more fragmented rest. Ranking input only — never a
  // feasibility gate (see module comment).
  restContinuityScore: number;
}

export interface RotationCandidate {
  groupCount: number;
  groups: RotationGroup[];
  // Headcount-weighted average of groups' restContinuityScore — the basis
  // this candidate was ranked against other feasible candidates on.
  qualityScore: number;
}

export interface RotationResult {
  feasible: boolean;
  candidate?: RotationCandidate;
  // Populated only when infeasible — the actual reason, never silently
  // swallowed, so the caller can surface a real capacity gap.
  reason?: string;
}

/**
 * Optional, explicit, management-supplied hint — never a source of truth
 * and never allowed to bypass feasibility testing. When given, its group
 * count is simply tried FIRST; if no candidate at that group count
 * satisfies the hard constraints, the engine falls through to the generic
 * search exactly as if no preference had been supplied.
 */
export interface RotationPreference {
  preferredGroupCount?: number;
}

function combinationsOfSize<T>(items: T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (size > items.length) return [];
  const [first, ...rest] = items;
  const withFirst = combinationsOfSize(rest, size - 1).map((c) => [first, ...c]);
  const withoutFirst = combinationsOfSize(rest, size);
  return [...withFirst, ...withoutFirst];
}

/** Cartesian product of `pool`, taken `slots` times (independent choices per slot). */
function cartesianProduct<T>(pool: T[], slots: number): T[][] {
  let results: T[][] = [[]];
  for (let s = 0; s < slots; s++) {
    const next: T[][] = [];
    for (const partial of results) {
      for (const choice of pool) next.push([...partial, choice]);
    }
    results = next;
  }
  return results;
}

/**
 * 1.0 when offDays forms one contiguous run over daysOrder; lower as it
 * fragments into more separate runs. Ranking input only — see the module
 * comment on hard feasibility vs. ranking.
 *
 * DELIBERATELY CYCLIC: daysOrder's last day is treated as adjacent to its
 * first day (Sunday→Monday wraps, exactly like Saturday→Sunday does), so
 * e.g. Air France's real OFF pattern [Monday, Sunday] scores 1.0 (fully
 * contiguous) even though "Monday" and "Sunday" are not adjacent in the
 * displayed Mon–Sun week layout — the underlying rest block genuinely IS
 * one uninterrupted two-day span (Sat night through Mon morning), a real
 * agent works Tuesday through Saturday and rests Sunday+Monday, which is
 * exactly as coherent as any other 2-day rest block. Displaying the week
 * starting on Monday is a UI choice, not a claim that the week doesn't
 * wrap — rest quality is a property of the actual rest period, not of
 * where a calendar grid happens to be cut. If ATLAS's week display or a
 * future confirmed rule ever needs Sunday/Monday treated as NOT adjacent,
 * that must be an explicit, separate decision — not an accidental
 * consequence of this function's implementation.
 */
function restContinuityScore(offDays: string[], daysOrder: string[]): number {
  if (offDays.length <= 1) return 1;
  const n = daysOrder.length;
  const indices = offDays.map((d) => daysOrder.indexOf(d)).sort((a, b) => a - b);
  let runs = 1;
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] !== indices[i - 1] + 1) runs++;
  }
  // Merge the wraparound run (e.g. Saturday, Sunday, Monday spans the
  // week boundary) so it doesn't get penalized as two separate runs.
  if (runs > 1 && indices[0] === 0 && indices[indices.length - 1] === n - 1) runs--;
  return 1 - (runs - 1) / (offDays.length - 1);
}

/**
 * Derives a viable team rotation, or reports that none exists at the
 * current headcount. `demandByDay` must have one entry per day in
 * `daysOrder`, same order. `normalWeeklyOffDays` is the resolved,
 * confirmed labor rule (see lib/labor-rules.ts) — never a value this
 * function invents or reads from a ceiling.
 */
export function deriveTeamRotation(
  headcount: number,
  demandByDay: DemandDay[],
  daysOrder: string[],
  normalWeeklyOffDays: number,
  preference?: RotationPreference,
  maxGroupCount = 4
): RotationResult {
  if (headcount <= 0) {
    return { feasible: false, reason: "No employees are assigned to this team — nothing to rotate." };
  }
  const n = daysOrder.length;
  if (normalWeeklyOffDays <= 0 || normalWeeklyOffDays >= n) {
    return {
      feasible: false,
      reason: `normalWeeklyOffDays (${normalWeeklyOffDays}) must leave at least one working day and at least one OFF day in a ${n}-day week.`,
    };
  }

  const cappedMaxGroups = Math.min(maxGroupCount, headcount);

  // Every distinct OFF-day set of the confirmed size — contiguous AND
  // fragmented alike. Fragmentation is never excluded here; it only
  // affects ranking, via restContinuityScore below.
  const offDaySets = combinationsOfSize(daysOrder, normalWeeklyOffDays);

  function bestCandidateForGroupCount(g: number): RotationCandidate | null {
    const base = Math.floor(headcount / g);
    const extra = headcount % g;
    const sizes = Array.from({ length: g }, (_, i) => base + (i < extra ? 1 : 0));

    // A group of size 0 (more groups requested than headcount usefully
    // supports at this split) can never cover anything — skip, don't
    // silently treat it as a valid empty group.
    if (sizes.some((s) => s === 0)) return null;

    let best: RotationCandidate | null = null;

    for (const combo of cartesianProduct(offDaySets, g)) {
      const groups: RotationGroup[] = sizes.map((size, i) => {
        const offDays = combo[i];
        const workingDays = daysOrder.filter((d) => !offDays.includes(d));
        return { offDays, workingDays, size, restContinuityScore: restContinuityScore(offDays, daysOrder) };
      });

      const shortfall = demandByDay.find((demand) => {
        if (demand.requiredAgents <= 0) return false;
        const workingHeadcount = groups
          .filter((gr) => !gr.offDays.includes(demand.dayOfWeek))
          .reduce((sum, gr) => sum + gr.size, 0);
        return workingHeadcount < demand.requiredAgents;
      });

      if (shortfall) continue; // fails the HARD coverage constraint — never a ranking matter

      const qualityScore = groups.reduce((sum, gr) => sum + gr.size * gr.restContinuityScore, 0) / headcount;

      if (!best || qualityScore > best.qualityScore) {
        best = { groupCount: g, groups, qualityScore };
      }
    }

    return best;
  }

  // An explicit management preference is an advisory HINT, not a source of
  // truth (see module comment) — but once it clears the same hard
  // feasibility gate as everything else, it's honored outright rather than
  // outranked by a higher-quality candidate at a different group count.
  // Without a preference, every group count up to cappedMaxGroups is
  // compared on equal footing and the highest-quality FEASIBLE one wins —
  // group count itself is not a hard rule, so a fragmented single-team
  // candidate must never silently beat a more coherent split-team one.
  if (preference?.preferredGroupCount && preference.preferredGroupCount >= 1 && preference.preferredGroupCount <= cappedMaxGroups) {
    const preferred = bestCandidateForGroupCount(preference.preferredGroupCount);
    if (preferred) return { feasible: true, candidate: preferred };
  }

  let globalBest: RotationCandidate | null = null;
  for (let g = 1; g <= cappedMaxGroups; g++) {
    const candidate = bestCandidateForGroupCount(g);
    if (!candidate) continue;
    if (
      !globalBest ||
      candidate.qualityScore > globalBest.qualityScore ||
      (candidate.qualityScore === globalBest.qualityScore && candidate.groupCount < globalBest.groupCount)
    ) {
      globalBest = candidate;
    }
  }
  if (globalBest) return { feasible: true, candidate: globalBest };

  return {
    feasible: false,
    reason: `No rotation using up to ${cappedMaxGroups} subteam(s) can cover this week's flight demand with ${headcount} assigned agent(s) while preserving ${normalWeeklyOffDays} OFF day(s) per person.`,
  };
}

/**
 * Thrown by the wiring layer (lib/employee-generator.ts) when
 * deriveTeamRotation reports infeasible for a configured team. This is an
 * OPERATIONAL RESULT — a real capacity gap — never something generation
 * silently works around with an unrelated flat roster. Carries the full
 * detail a human needs to resolve it (add headcount, request renfort,
 * etc.) and rerun.
 */
export class RotationInfeasibleError extends Error {
  readonly team: string;
  readonly headcount: number;
  readonly demandByDay: DemandDay[];
  readonly reason: string;

  constructor(team: string, headcount: number, demandByDay: DemandDay[], reason: string) {
    const affectedDays = demandByDay.filter((d) => d.requiredAgents > 0).map((d) => `${d.dayOfWeek} (needs ${d.requiredAgents})`);
    super(
      `team_rotation_infeasible: "${team}" has ${headcount} assigned agent(s), which cannot cover its real weekly demand [${affectedDays.join(
        ", "
      )}] under the confirmed 2-OFF-days rule. ${reason} This is a genuine capacity gap, not a bug — resolve it with an explicit human action (add headcount, or invoke an explicit renfort decision once that workflow exists) and regenerate.`
    );
    this.name = "RotationInfeasibleError";
    this.team = team;
    this.headcount = headcount;
    this.demandByDay = demandByDay;
    this.reason = reason;
  }
}
