/**
 * Centralized team/company color identity — mirrors the operator's Excel
 * planning sheet convention (each team/company gets one consistent
 * color), but restrained for ATLAS: used as a small dot/badge accent, not
 * for coloring whole rows or cards.
 *
 * This is the single source of truth. Any screen that needs a team or
 * company's color (Employees now; Weekly Planning, the employee
 * schedule/timeline, and Live Operations later) should import from here
 * rather than defining its own palette — that's what keeps "Emirates is
 * always this color" true across the app.
 */
export const TEAM_COLORS: Record<string, string> = {
  // Internal RAM services (see lib/teams.ts TEAMS)
  "General T1 Pool": "#64748B",
  Transit: "#6366F1",
  Profiling: "#A855F7",
  Mesure: "#14B8A6",
  "Baggage Claim": "#F59E0B",
  "Caisse/BCB": "#F43F5E",
  "Service Plus": "#D946EF",
  Leaders: "#3B82F6",
  "Duty Officers": "#06B6D4",
  // Foreign companies (see lib/company-config.ts CONFIGURED_COMPANIES)
  Emirates: "#DC2626",
  "Qatar Airways": "#9F1239",
  Etihad: "#92400E",
  "Gulf Air": "#16A34A",
  "Air France": "#0284C7",
};

const FALLBACK_COLOR = "#9CA3AF"; // neutral gray, for any team/company not in the map above

export function getTeamColor(name: string): string {
  return TEAM_COLORS[name] ?? FALLBACK_COLOR;
}
