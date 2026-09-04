import { describe, it, expect } from "vitest";
import {
  isFlexibleGeneralPool,
  isForeignCompanyAssigned,
  isFixedSpecializedTeam,
  isTransitAssigned,
  isProfilingOrMesureAssigned,
} from "../lib/planning/workforce-pools";
import { EMPLOYEES } from "../lib/seed-data";
import { Employee } from "../lib/types";

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

  it("a Profiling-placed employee is NOT flexible pool, even though they hold the Profiling skill", () => {
    const profilingEmployee = EMPLOYEES.find((e) => e.assignment === "Profiling")!;
    expect(profilingEmployee).toBeDefined();
    expect(isProfilingOrMesureAssigned(profilingEmployee)).toBe(true);
    expect(isFlexibleGeneralPool(profilingEmployee)).toBe(false);
  });

  it("a Mesure-placed employee is NOT flexible pool", () => {
    const mesureEmployee = EMPLOYEES.find((e) => e.assignment === "Mesure")!;
    expect(mesureEmployee).toBeDefined();
    expect(isProfilingOrMesureAssigned(mesureEmployee)).toBe(true);
    expect(isFlexibleGeneralPool(mesureEmployee)).toBe(false);
  });

  it("qualification vs. placement: a General T1 Pool employee who happens to hold the Profiling SKILL is still flexible pool", () => {
    // This is the exact distinction the brief draws: qualification never
    // by itself restricts flexibility — only current PLACEMENT does.
    const generalT1WithProfilingSkill: Employee = {
      id: "test-flex-profiling-skill",
      name: "Test Employee",
      skills: ["Boarding", "Profiling"],
      assignment: "General T1 Pool", // placement, not Profiling
      shift_code: "AP01",
      shift_start: "13:45",
      shift_end: "22:45",
      rest_before_shift_hours: 12,
      weekly_hours: 10,
      is_duty_officer: false,
      off_days: [],
      foreign_company_authorizations: [],
      active: true,
      weekly_shifts: [],
    };
    expect(isProfilingOrMesureAssigned(generalT1WithProfilingSkill)).toBe(false);
    expect(isFlexibleGeneralPool(generalT1WithProfilingSkill)).toBe(true);
  });

  it("every employee falls into exactly the pool categories consistent with their assignment — no employee is flexible AND fixed/foreign/transit/Profiling/Mesure simultaneously", () => {
    for (const e of EMPLOYEES) {
      const flags = [
        isForeignCompanyAssigned(e),
        isFixedSpecializedTeam(e),
        isTransitAssigned(e),
        isProfilingOrMesureAssigned(e),
      ];
      const anyRestricted = flags.some(Boolean);
      if (anyRestricted) {
        expect(isFlexibleGeneralPool(e)).toBe(false);
      }
    }
  });
});
