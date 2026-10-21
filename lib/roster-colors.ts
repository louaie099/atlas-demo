/**
 * Centralized semantic color system for the Agent Schedule roster grid.
 * Every cell's color comes from here — never a one-off Tailwind class
 * chosen inline per cell — so "what does this color mean" stays
 * consistent across the whole grid instead of drifting cell by cell.
 *
 * (2026-10-21: working days are all tinted and OFF is a quiet neutral gray, so a shift never reads as an absence and rest never reads as an alert.)
 *
 * Deliberately kept separate from lib/team-colors.ts: team/company
 * identity (the airline dot in a foreign-commitment indicator) is its own
 * secondary signal, orthogonal to what KIND of day this is (rest, day
 * shift, night shift, normal shift). A cell can carry both at once (a
 * working day AND a foreign commitment) without them fighting for the
 * same visual channel — the shift-family tint owns the cell background,
 * team identity stays a small secondary badge (see TeamBadge).
 *
 * Semantic categories, each with an operationally distinct meaning:
 *  - off:        scheduled REST. Never confused with a warning — this is
 *                the calendar working as intended, not a problem.
 *  - dayShift:   JR-family codes specifically (JR01/JR02) — the confirmed
 *                fixed-cycle "day" step for Transit/Leaders.
 *  - nightShift: NT-family codes specifically (NT01) — the confirmed
 *                fixed-cycle "night" step.
 *  - normalShift: every other real shift code (MT/NR/AP/N8/...) — kept
 *                deliberately neutral. Operational readability, not a
 *                rainbow spreadsheet: shift-code IDENTITY still comes
 *                through as text, just without a bespoke color per code.
 *  - assignedDuty / confirmedDuty: the draft-plan tone system (calm brand
 *                blue for ATLAS's own draft-plan assignment, green for a
 *                real confirmed Assignment) — same tones Flight Coverage
 *                uses, reused here rather than reinvented. Renamed from
 *                the earlier "proposedDuty" now that ordinary generated
 *                duties are assignments, not pending recommendations —
 *                see lib/types.ts's RequirementCoverageStatus doc comment.
 *  - warning:    a genuine planning PROBLEM (rest violation, consecutive-
 *                OFF violation, weekly-hours violation, unfilled duty).
 *                Uses the existing amber `warn` family — visually
 *                distinct from off's rose/pink on purpose, so "resting"
 *                and "something is wrong" are never mistakable for each
 *                other at a glance.
 */

export interface RosterCellTone {
  /** Applied to the whole cell/button background. */
  bg: string;
  /** Primary text color for content inside the cell. */
  text: string;
}

export const ROSTER_COLORS: {
  off: RosterCellTone;
  dayShift: RosterCellTone;
  nightShift: RosterCellTone;
  morningShift: RosterCellTone;
  middayShift: RosterCellTone;
  afternoonShift: RosterCellTone;
  normalShift: RosterCellTone;
  assignedDuty: string; // text-only secondary indicator, existing convention
  confirmedDuty: string; // text-only secondary indicator, existing convention
  warning: string; // text-only secondary indicator, existing convention
} = {
  // One clear hue per shift family so the grid reads at a glance:
  // morning = blue, midday/office = green, afternoon = orange,
  // night = violet, fixed-cycle day = teal, OFF = neutral gray.
  off: { bg: "bg-gray-100", text: "text-gray-500" },
  morningShift: { bg: "bg-sky-100", text: "text-sky-900" },
  middayShift: { bg: "bg-emerald-100", text: "text-emerald-900" },
  afternoonShift: { bg: "bg-orange-100", text: "text-orange-900" },
  nightShift: { bg: "bg-violet-200", text: "text-violet-900" },
  dayShift: { bg: "bg-teal-100", text: "text-teal-900" },
  normalShift: { bg: "bg-slate-100", text: "text-slate-800" },
  assignedDuty: "text-brand-700",
  confirmedDuty: "text-good-700",
  warning: "text-warn-700",
};

export type ShiftFamily = "off" | "dayShift" | "nightShift" | "morningShift" | "middayShift" | "afternoonShift" | "normalShift";

/**
 * Classifies a shift code into its color family — purely by the
 * confirmed JR/NT code prefixes (see lib/fixed-cycle-rotation.ts's
 * JR_NT_OFF_OFF_CYCLE), never by team/company name. A `null` code (an
 * OFF day) is its own family. Every other real catalog code (MT/NR/AP/N8)
 * falls through to "normalShift" — intentionally neutral, not because
 * those codes are less important, but because giving every code its own
 * hue would defeat "operational readability, not a rainbow spreadsheet."
 */
export function shiftFamilyFor(shiftCode: string | null): ShiftFamily {
  if (!shiftCode) return "off";
  if (shiftCode.startsWith("JR")) return "dayShift";
  if (shiftCode.startsWith("NT") || shiftCode.startsWith("N8")) return "nightShift";
  if (shiftCode.startsWith("MT")) return "morningShift";
  if (shiftCode.startsWith("NR")) return "middayShift";
  if (shiftCode.startsWith("AP")) return "afternoonShift";
  return "normalShift";
}

export function rosterCellTone(shiftCode: string | null): RosterCellTone {
  return ROSTER_COLORS[shiftFamilyFor(shiftCode)];
}
