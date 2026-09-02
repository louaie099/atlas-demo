import { describe, it, expect } from "vitest";
import { isFlexibleGeneralPool, isForeignCompanyAssigned, isFixedSpecializedTeam, isTransitAssigned } from "../lib/planning/workforce-pools";
import { EMPLOYEES } from "../lib/seed-data";

describe("workforce pool classification against real seed data", () => {
  it("Sara Bennis (General T1 Pool) is flexible pool", () => {
    const sara = EMPLOYEES.find((e) => e.id === "sara-bennis")!;
    expect(isFlexibleGeneralPool(sara)).toBe(true);
  });

  it("an employee assigned to Emirates is NOT flexible pool", () => {
    const emiratesEmployee = EMPLOYEES.find((e) => isForeignCompanyAssigned(e))!;
    expect(emiratesEmployee).toBeDefined();
    expect(isFlexibleGeneralPool(emiratesEmployee)).toBe(false);
  });

  it("Mohammed Alaoui (Duty Officer) is NOT flexible pool", () => {
    const mohammed = EMPLOYEES.find((e) => e.id === "mohammed-alaoui")!;
    expect(isFixedSpecializedTeam(mohammed)).toBe(true);
    expect(isFlexibleGeneralPool(mohammed)).toBe(false);
  });

  it("a Transit-assigned employee is NOT flexible pool", () => {
    const transitEmployee = EMPLOYEES.find((e) => isTransitAssigned(e))!;
    expect(transitEmployee).toBeDefined();
    expect(isFlexibleGeneralPool(transitEmployee)).toBe(false);
  });

  it("every employee falls into exactly the pool categories consistent with their assignment — no employee is flexible AND fixed/foreign/transit simultaneously", () => {
    for (const e of EMPLOYEES) {
      const flags = [isForeignCompanyAssigned(e), isFixedSpecializedTeam(e), isTransitAssigned(e)];
      const anyRestricted = flags.some(Boolean);
      if (anyRestricted) {
        expect(isFlexibleGeneralPool(e)).toBe(false);
      }
    }
  });
});
