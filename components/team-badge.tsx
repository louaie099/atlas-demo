import { getTeamColor } from "@/lib/team-colors";

/**
 * Restrained team/company identity indicator: a small colored dot plus
 * the name, using the centralized color mapping (lib/team-colors.ts).
 * Deliberately not a heavy colored pill — matches "rapid recognition, not
 * decoration."
 */
export function TeamBadge({ name }: { name: string }) {
  const color = getTeamColor(name);
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-ink">
      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
      {name}
    </span>
  );
}
