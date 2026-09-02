/**
 * Presentation grouping only — does not change Employee.skills, which
 * remains a flat array. Groups are for scannability in the UI, not a new
 * domain concept. Skills not listed here (shouldn't happen, but handled
 * defensively) fall into "Other".
 */
export const SKILL_GROUPS: Record<string, string[]> = {
  Core: ["Check-in", "Weight Control"],
  Airside: ["Boarding", "Gate", "Care Point", "Arrivals"],
  Specialized: ["Profiling", "Mesure", "Transit", "Service Plus", "Caisse/BCB", "Ramp Team", "Business Class"],
};

export function groupSkills(skills: string[]): { group: string; skills: string[] }[] {
  const groups: { group: string; skills: string[] }[] = [];

  for (const [group, groupSkillList] of Object.entries(SKILL_GROUPS)) {
    const matched = skills.filter((s) => groupSkillList.includes(s));
    if (matched.length > 0) groups.push({ group, skills: matched });
  }

  const grouped = new Set(groups.flatMap((g) => g.skills));
  const other = skills.filter((s) => !grouped.has(s));
  if (other.length > 0) groups.push({ group: "Other", skills: other });

  return groups;
}
