import { describe, it, expect } from "vitest";
import { validateImportFile } from "../lib/employee-import";

/**
 * Bulk Import Employees — same validate-then-preview shape as Import
 * Flights (tests/flight-import.test.ts), covering the rules
 * lib/employee-import.ts documents: required columns, duplicate-id
 * rejection (existing and within-file), unknown-vocabulary warnings
 * (never rejections), and the exact creation schema POST /api/employees
 * already enforces for a single employee.
 */
describe("Import Employees — validation", () => {
  const header = "name,skills,assignment,foreign_company_authorizations,is_duty_officer";

  it("a row with a known skill and no assignment given defaults to General T1 Pool and is ready", () => {
    const csv = `${header}\nKarim Idrissi,Gate;Boarding,,,`;
    const rows = validateImportFile(csv, new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("ready");
    expect(rows[0].employee).toMatchObject({
      id: "karim-idrissi",
      name: "Karim Idrissi",
      skills: ["Gate", "Boarding"],
      assignment: "General T1 Pool",
      foreign_company_authorizations: [],
      is_duty_officer: false,
      active: true,
      shift_code: null,
    });
  });

  it("missing name or an empty skills cell is rejected, not silently defaulted", () => {
    const csv = [header, ",Gate,,,", "Yasmine Alaoui,,,,"].join("\n");
    const rows = validateImportFile(csv, new Set());
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe("rejected");
    expect(rows[0].problems[0]).toMatch(/Missing required value/);
    expect(rows[1].status).toBe("rejected");
    expect(rows[1].problems[0]).toMatch(/Missing required value/);
  });

  it("a skills cell holding only a delimiter (no real value) is rejected with the qualification-specific message", () => {
    const csv = `${header}\nYasmine Alaoui,;,,,`;
    const rows = validateImportFile(csv, new Set());
    expect(rows[0].status).toBe("rejected");
    expect(rows[0].problems[0]).toMatch(/at least one qualification/);
  });

  it("a duplicate id against an ALREADY-PERSISTED employee is rejected", () => {
    const csv = `${header}\nKarim Idrissi,Gate,,,`;
    const rows = validateImportFile(csv, new Set(["karim-idrissi"]));
    expect(rows[0].status).toBe("rejected");
    expect(rows[0].problems[0]).toMatch(/already exists/);
  });

  it("two rows in the SAME file that slugify to the same id — the second is rejected as an in-file duplicate", () => {
    const csv = [header, "Karim Idrissi,Gate,,,", "Karim  Idrissi,Boarding,,,"].join("\n");
    const rows = validateImportFile(csv, new Set());
    expect(rows[0].status).toBe("ready");
    expect(rows[1].status).toBe("rejected");
    expect(rows[1].problems[0]).toMatch(/appears more than once/);
  });

  it("an unrecognized skill is a WARNING, not a rejection — the row still imports", () => {
    const csv = `${header}\nKarim Idrissi,Gate;Forklift,,,`;
    const rows = validateImportFile(csv, new Set());
    expect(rows[0].status).toBe("warning");
    expect(rows[0].employee?.skills).toEqual(["Gate", "Forklift"]);
    expect(rows[0].problems[0]).toMatch(/not in the confirmed vocabulary/);
  });

  it("an assignment that isn't a known internal team or configured carrier is a WARNING, not a rejection", () => {
    const csv = `${header}\nKarim Idrissi,Gate,Turkish Airlines,,`;
    const rows = validateImportFile(csv, new Set());
    expect(rows[0].status).toBe("warning");
    expect(rows[0].employee?.assignment).toBe("Turkish Airlines");
    expect(rows[0].problems[0]).toMatch(/isn't a known internal team/);
  });

  it("a known internal team and a known foreign-company authorization are both ready, no warnings", () => {
    const csv = `${header}\nKarim Idrissi,Gate,Profiling,Qatar Airways,`;
    const rows = validateImportFile(csv, new Set());
    expect(rows[0].status).toBe("ready");
    expect(rows[0].employee?.assignment).toBe("Profiling");
    expect(rows[0].employee?.foreign_company_authorizations).toEqual(["Qatar Airways"]);
  });

  it("an unconfigured foreign-company authorization is a WARNING, not a rejection", () => {
    const csv = `${header}\nKarim Idrissi,Gate,,Royal Jordanian,`;
    const rows = validateImportFile(csv, new Set());
    expect(rows[0].status).toBe("warning");
    expect(rows[0].problems[0]).toMatch(/not currently configured/);
  });

  it("is_duty_officer parses true/false (case-insensitive) and blank defaults to false; an invalid value is rejected", () => {
    const csv = [header, "A,Gate,,,TRUE", "B,Gate,,,false", "C,Gate,,,", "D,Gate,,,maybe"].join("\n");
    const rows = validateImportFile(csv, new Set());
    expect(rows[0].employee?.is_duty_officer).toBe(true);
    expect(rows[1].employee?.is_duty_officer).toBe(false);
    expect(rows[2].employee?.is_duty_officer).toBe(false);
    expect(rows[3].status).toBe("rejected");
    expect(rows[3].problems[0]).toMatch(/must be "true" or "false"/);
  });

  it("never invents planning state — a parsed row has no shift_start/shift_end/rest_before_shift_hours/weekly_hours/weekly_shifts", () => {
    const csv = `${header}\nKarim Idrissi,Gate,,,`;
    const rows = validateImportFile(csv, new Set());
    const employee = rows[0].employee as Record<string, unknown>;
    expect(employee).not.toHaveProperty("shift_start");
    expect(employee).not.toHaveProperty("shift_end");
    expect(employee).not.toHaveProperty("rest_before_shift_hours");
    expect(employee).not.toHaveProperty("weekly_hours");
    expect(employee).not.toHaveProperty("weekly_shifts");
  });

  it("a CSV missing a required column is rejected outright with a clear message, before any row is parsed", () => {
    expect(() => validateImportFile("name,assignment\nKarim,General T1 Pool", new Set())).toThrow(/missing required column.*skills/i);
  });
});
