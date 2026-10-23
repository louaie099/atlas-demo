import { parseCSV } from "./flight-import";
import { Employee } from "./types";
import { TEAMS } from "./teams";
import { CONFIGURED_COMPANIES } from "./company-config";
import { ADDABLE_QUALIFICATION_GROUPS } from "./skill-groups";

/**
 * Bulk Import Employees — the workforce-profile equivalent of
 * lib/flight-import.ts's Import Flights pipeline, same shape on purpose:
 * parse -> validate every row (ready/warning/rejected, never silently
 * mis-imported) -> preview -> commit. Added because the existing
 * employee creation path (app/api/employees/route.ts POST) only ever
 * created ONE employee per call -- workable for a handful of demo
 * employees, not for onboarding a real pilot team's full roster.
 *
 * Deliberately mirrors POST /api/employees's own creation schema and
 * rules EXACTLY (see that route's doc comment) rather than inventing a
 * new one: name, skills (non-empty), assignment (defaults to "General T1
 * Pool"), foreign_company_authorizations (optional), is_duty_officer
 * (optional, defaults false). Planning state (shift_start/shift_end/
 * rest_before_shift_hours/weekly_hours/shift_code/weekly_shifts) is never
 * accepted here either, for the exact same reason that route gives: it
 * belongs to Weekly Planning/roster generation, not employee creation,
 * and inventing it at import time would be fabricating data nobody gave
 * us. Every imported employee starts with no roster, exactly like one
 * created through the UI one at a time.
 */
export const IMPORT_COLUMNS = ["name", "skills", "assignment", "foreign_company_authorizations", "is_duty_officer"] as const;

const REQUIRED_COLUMNS = ["name", "skills"];

// The confirmed qualification vocabulary (lib/skill-groups.ts) -- an
// unrecognized skill is a WARNING, not a rejection, same reasoning as
// Import Flights' unconfigured-destination case: it's real, importable
// data that needs a human look, not evidence the whole row is broken.
const KNOWN_SKILLS = new Set(ADDABLE_QUALIFICATION_GROUPS.flatMap((g) => g.skills));

// A valid `assignment` is either an internal RAM team (lib/teams.ts) or a
// currently-configured foreign carrier (lib/company-config.ts). Anything
// else (a typo, or a real carrier Atlas just hasn't been configured for
// yet -- Turkish Airlines is the deliberate real-world example) is a
// warning: importable, but flagged for review, never silently dropped or
// rejected outright.
const KNOWN_ASSIGNMENTS = new Set<string>([...TEAMS, ...CONFIGURED_COMPANIES]);

export interface ParsedEmployeeRow {
  rowNumber: number; // 1-based, header is row 1 -- matches what a person sees opening the file in a spreadsheet
  raw: Record<string, string>;
  status: "ready" | "warning" | "rejected";
  problems: string[]; // rejected rows have at least one; warning rows have at least one non-blocking note
  employee: Omit<Employee, "shift_start" | "shift_end" | "rest_before_shift_hours" | "weekly_hours" | "weekly_shifts" | "off_days"> | null;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// Cell-internal list delimiter for skills / foreign_company_authorizations
// -- semicolon, not comma, since names like "Qatar Airways" and skill
// labels never contain one, and the outer file is itself comma-separated.
function splitList(cell: string | undefined): string[] {
  if (!cell || !cell.trim()) return [];
  return cell
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function validateRow(
  rowNumber: number,
  raw: Record<string, string>,
  existingIds: Set<string>,
  seenInFile: Set<string>
): ParsedEmployeeRow {
  const missing = REQUIRED_COLUMNS.filter((c) => !raw[c]?.trim());
  if (missing.length > 0) {
    return { rowNumber, raw, status: "rejected", problems: [`Missing required value(s): ${missing.join(", ")}`], employee: null };
  }

  const name = raw.name.trim();
  const skills = splitList(raw.skills);
  const assignment = raw.assignment?.trim() || "General T1 Pool";
  const foreign_company_authorizations = splitList(raw.foreign_company_authorizations);
  const rawDutyOfficer = raw.is_duty_officer?.trim().toLowerCase() || "false";

  if (skills.length === 0) {
    return { rowNumber, raw, status: "rejected", problems: ["skills must list at least one qualification (semicolon-separated)"], employee: null };
  }

  if (rawDutyOfficer !== "true" && rawDutyOfficer !== "false" && rawDutyOfficer !== "") {
    return {
      rowNumber,
      raw,
      status: "rejected",
      problems: [`is_duty_officer "${raw.is_duty_officer}" must be "true" or "false" (or left blank)`],
      employee: null,
    };
  }
  const is_duty_officer = rawDutyOfficer === "true";

  const id = slugify(name);
  if (!id) {
    return { rowNumber, raw, status: "rejected", problems: [`name "${raw.name}" produces an empty id once slugified`], employee: null };
  }
  if (existingIds.has(id)) {
    return { rowNumber, raw, status: "rejected", problems: [`An employee with id "${id}" already exists`], employee: null };
  }
  if (seenInFile.has(id)) {
    return { rowNumber, raw, status: "rejected", problems: [`"${name}" (id "${id}") appears more than once in this file`], employee: null };
  }

  const warnings: string[] = [];
  const unknownSkills = skills.filter((s) => !KNOWN_SKILLS.has(s));
  if (unknownSkills.length > 0) {
    warnings.push(`Qualification(s) not in the confirmed vocabulary yet, imported as given -- review before relying on them: ${unknownSkills.join(", ")}`);
  }
  if (!KNOWN_ASSIGNMENTS.has(assignment)) {
    warnings.push(`Assignment "${assignment}" isn't a known internal team or a currently-configured foreign carrier -- this employee will need configuration before they get staffing coverage there`);
  }
  const unknownAuthorizations = foreign_company_authorizations.filter((c) => !CONFIGURED_COMPANIES.includes(c));
  if (unknownAuthorizations.length > 0) {
    warnings.push(`Foreign-company authorization(s) not currently configured: ${unknownAuthorizations.join(", ")}`);
  }

  const employee = {
    id,
    name,
    skills,
    assignment,
    foreign_company_authorizations,
    is_duty_officer,
    active: true,
    shift_code: null,
  };

  return { rowNumber, raw, status: warnings.length > 0 ? "warning" : "ready", problems: warnings, employee };
}

export function validateImportFile(csvText: string, existingIds: Set<string>): ParsedEmployeeRow[] {
  const { header, rows } = parseCSV(csvText);
  const missingColumns = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missingColumns.length > 0) {
    throw new Error(`CSV is missing required column(s): ${missingColumns.join(", ")}. Expected columns: ${IMPORT_COLUMNS.join(", ")}`);
  }

  const seenInFile = new Set<string>();
  const results: ParsedEmployeeRow[] = [];
  rows.forEach((cells, i) => {
    const raw: Record<string, string> = {};
    header.forEach((col, colIdx) => {
      raw[col] = cells[colIdx] ?? "";
    });
    const result = validateRow(i + 2, raw, existingIds, seenInFile); // +2: 1-based, plus the header row
    if (result.employee) seenInFile.add(result.employee.id);
    results.push(result);
  });
  return results;
}
