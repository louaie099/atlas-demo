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
