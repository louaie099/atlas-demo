import { describe, it, expect } from "vitest";
import { scoreCandidates } from "../lib/scoring";
import { EMPLOYEES, CONFIG } from "../lib/seed-data";

describe("scoreCandidates", () => {
  it("recommends Nadia Ziani for the AT201 Boarding gap", () => {
    const results = scoreCandidates("Boarding", { start: "13:50", end: "14:20" }, EMPLOYEES, CONFIG);
    const nadia = results.find((r) => r.employee.id === "nadia-ziani");
    expect(nadia?.status).toBe("recommended");
    expect(nadia?.reasoning).toContain("11h rest");
  });

  it("flags Karim Idrissi for the AT201 Boarding gap", () => {
    const results = scoreCandidates("Boarding", { start: "13:50", end: "14:20" }, EMPLOYEES, CONFIG);
    const karim = results.find((r) => r.employee.id === "karim-idrissi");
    expect(karim?.status).toBe("flagged");
    expect(karim?.reasoning).toContain("unplanned shift extension");
    // CONFIG.fairness_ceiling_hours is "unconfirmed" (lib/labor-rules.ts) —
    // an unconfirmed ceiling is never enforced or mentioned, so Karim is
    // flagged for the shift extension alone, not for "approaching" a
    // ceiling that doesn't have a confirmed value.
    expect(karim?.reasoning).not.toContain("ceiling");
  });

  it("recommends both Hicham Bouzid and Rania Toumi for the AT535 Check-in gap", () => {
    const results = scoreCandidates("Check-in", { start: "08:15", end: "08:45" }, EMPLOYEES, CONFIG);
    const hicham = results.find((r) => r.employee.id === "hicham-bouzid");
    const rania = results.find((r) => r.employee.id === "rania-toumi");
    expect(hicham?.status).toBe("recommended");
    expect(rania?.status).toBe("recommended");
  });

  it("sorts recommended candidates before flagged candidates", () => {
    const results = scoreCandidates("Boarding", { start: "13:50", end: "14:20" }, EMPLOYEES, CONFIG);
    const firstFlaggedIndex = results.findIndex((r) => r.status === "flagged");
    const lastRecommendedIndex = results.map((r) => r.status).lastIndexOf("recommended");
    expect(lastRecommendedIndex).toBeLessThan(firstFlaggedIndex === -1 ? Infinity : firstFlaggedIndex);
  });

  it("excludes the Duty Officer from candidate pools", () => {
    const results = scoreCandidates("Boarding", { start: "13:50", end: "14:20" }, EMPLOYEES, CONFIG);
    expect(results.find((r) => r.employee.id === "mohammed-alaoui")).toBeUndefined();
  });
});

describe("scoreCandidates — requiredAuthorization (company_config eligibility)", () => {
  it("with requiredAuthorization set, eligibility is real foreign-company authorization, NOT a skill match", () => {
    const authorizedNotSkilled = {
      id: "e1", name: "Authorized", skills: [], assignment: "Gulf Air",
      shift_code: "MT02", shift_start: "04:30", shift_end: "14:30", rest_before_shift_hours: 12,
      weekly_hours: 20, is_duty_officer: false, off_days: [], foreign_company_authorizations: ["Gulf Air"],
      active: true, weekly_shifts: [],
    };
    const skilledNotAuthorized = {
      id: "e2", name: "Skilled Only", skills: ["Company Team"], assignment: "Emirates",
      shift_code: "MT02", shift_start: "04:30", shift_end: "14:30", rest_before_shift_hours: 12,
      weekly_hours: 20, is_duty_officer: false, off_days: [], foreign_company_authorizations: ["Emirates"],
      active: true, weekly_shifts: [],
    };
    const results = scoreCandidates(
      "Company Team",
      { start: "08:00", end: "09:00" },
      [authorizedNotSkilled, skilledNotAuthorized],
      CONFIG,
      {},
      "Gulf Air"
    );
    expect(results.map((r) => r.employee.id)).toEqual(["e1"]); // authorization decides it, not the "skills" array
  });

  it("without requiredAuthorization, eligibility falls back to the ordinary skill match (unchanged behavior for every other role)", () => {
    const results = scoreCandidates("Boarding", { start: "13:50", end: "14:20" }, EMPLOYEES, CONFIG);
    expect(results.length).toBeGreaterThan(0);
  });
});
