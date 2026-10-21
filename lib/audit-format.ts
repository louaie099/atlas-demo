/**
 * Presentation helpers for audit_log_entries.description (Command Center
 * redesign follow-up, 2026-10-21). The stored text is written for traceability
 * and contains artifacts of string concatenation (".." / "..)"); the UI
 * tidies it for display only — the persisted record is never altered.
 */
export type AuditTagLabel = "Plan" | "Reassignment" | "Override" | "Setup" | "Event";
export type AuditTagTone = "brand" | "warn" | "neutral" | "good";

export const AUDIT_TAGS: AuditTagLabel[] = ["Plan", "Reassignment", "Override", "Setup", "Event"];

export function auditTag(description: string): { label: AuditTagLabel; tone: AuditTagTone } {
  if (/override|flagged/i.test(description)) return { label: "Override", tone: "warn" };
  if (/reassign|moved/i.test(description)) return { label: "Reassignment", tone: "brand" };
  if (/seeded|dataset/i.test(description)) return { label: "Setup", tone: "neutral" };
  if (/plan/i.test(description)) return { label: "Plan", tone: "neutral" };
  return { label: "Event", tone: "neutral" };
}

export function tidyAuditText(description: string): string {
  return description
    .replace(/^Operational reassignment:\s*/i, "")
    .replace(/\.\.(?=[\s)]|$)/g, ".")
    .replace(/\.\s*\)/g, ")")
    .replace(/\s{2,}/g, " ")
    .trim();
}
