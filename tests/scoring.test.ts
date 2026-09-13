import { describe, it, expect } from "vitest";
import { scoreCandidates } from "../lib/scoring";
import { EMPLOYEES, CONFIG } from "../lib/seed-data";

describe("scoreCandidates", () => {
  it("flags Nadia Ziani for the AT201 Boarding gap — her real NR02 shift's derived rest (13.75h) now falls short of the confirmed 15h floor", () => {
    // Nadia's rest_before_shift_hours is no longer a hand-picked 11h
    // placeholder — it's derived from her real NR02 shift catalog
    // duration (08:00-18:15 = 10.25h -> 24-10.25 = 13.75h rest). That
    // real value is below the newly confirmed 15h minimum rest floor, so
    // she is honestly flagged rather than recommended. This is a genuine,
    // reportable consequence of the confirmed rule (see the delivered
    // report), not a bug: her OLD 11h value predated the 15h floor and
    // was never reconciled against it either (11h was already below the
    // even-older 10h floor's replacement).
    const results = scoreCandidates("Boarding", { start: "13:50", end: "14:20" }, EMPLOYEES, CONFIG);
    const nadia = results.find((r) => r.employee.id === "nadia-ziani");
    expect(nadia?.status).toBe("flagged");
    expect(nadia?.reasoning).toContain("13.75h");
    expect(nadia?.reasoning).toContain("15h minimum");
  });

  it("flags Karim Idrissi for the AT201 Boarding gap", () => {
    const results = scoreCandidates("Boarding", { start: "13:50", end: "14:20" }, EMPLOYEES, CONFIG);
    const karim = results.find((r) => r.employee.id === "karim-idrissi");
    expect(karim?.status).toBe("flagged");
    expect(karim?.reasoning).toContain("unplanned shift extension");
    // CONFIG.maximum_average_weekly_working_hours is a CONFIRMED 42h
    // average (see lib/labor-rules.ts) — Karim's scripted 38h weekly
    // total genuinely IS within 5h of that confirmed average (38 >= 42-5),
    // so "approaching" it is an accurate, expected part of his reasoning
    // (a soft, human-review heuristic — see scoring.ts's nearCeiling doc
    // comment — never a hard per-week violation, since the reference
    // period is unconfirmed).
    expect(karim?.reasoning).toContain("confirmed 42h average");
  });

  it("recommends Hicham Bouzid, but flags Rania Toumi, for the AT535 Check-in gap — their real shifts' derived rest differs (MT01: 15h, at the floor; MT02: 13.75h, below it)", () => {
    const results = scoreCandidates("Check-in", { start: "08:15", end: "08:45" }, EMPLOYEES, CONFIG);
    const hicham = results.find((r) => r.employee.id === "hicham-bouzid");
    const rania = results.find((r) => r.employee.id === "rania-toumi");
    expect(hicham?.status).toBe("recommended");
    expect(rania?.status).toBe("flagged");
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
