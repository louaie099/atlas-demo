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

/**
 * The confirmed, curated qualification vocabulary offered when CREATING a
 * new employee — deliberately narrower than SKILL_GROUPS above, which
 * still includes legacy qualifiers (Arrivals, Ramp Team, Business Class)
 * kept only because existing employees' data depends on them (e.g. Amina
 * Fassi's Care Point skill, Sara Bennis's Business Class). New employees
 * should only ever be given qualifications from this list — Arrivals and
 * Ramp Team are explicitly excluded here since they were never confirmed
 * as real ATLAS qualifications, just MVP-era placeholders.
 */
export const ADDABLE_QUALIFICATION_GROUPS: { group: string; skills: string[] }[] = [
  { group: "Core", skills: ["Check-in", "Weight Control"] },
  { group: "Airside", skills: ["Boarding", "Gate", "Care Point"] },
  { group: "Specialized", skills: ["Profiling", "Mesure", "Transit", "Caisse/BCB", "Service Plus"] },
];
