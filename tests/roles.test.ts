import { describe, it, expect } from "vitest";
import { canManageEmployees, canManageOperations, canManageLaborRules, getRoleFromHeader } from "../lib/roles";

describe("canManageEmployees", () => {
  it("only Administrator can manage employees", () => {
    expect(canManageEmployees("administrator")).toBe(true);
    expect(canManageEmployees("planner")).toBe(false);
    expect(canManageEmployees("viewer")).toBe(false);
  });
});

describe("canManageLaborRules", () => {
  it("only Administrator can edit Planning Rules (Planner and Viewer may still view them elsewhere)", () => {
    expect(canManageLaborRules("administrator")).toBe(true);
    expect(canManageLaborRules("planner")).toBe(false);
    expect(canManageLaborRules("viewer")).toBe(false);
  });
});

describe("canManageOperations", () => {
  it("allows Planner and Administrator (the 'Regulator'/'DO' boundary for Live Operations manual assign/reassign), blocks Viewer", () => {
    expect(canManageOperations("planner")).toBe(true);
    expect(canManageOperations("administrator")).toBe(true);
    expect(canManageOperations("viewer")).toBe(false);
  });
});

describe("getRoleFromHeader", () => {
  it("returns the role when it's a valid elevated role", () => {
    expect(getRoleFromHeader("administrator")).toBe("administrator");
    expect(getRoleFromHeader("planner")).toBe("planner");
  });

  it("defaults to the least-privileged role (viewer) when missing", () => {
    expect(getRoleFromHeader(null)).toBe("viewer");
  });

  it("defaults to viewer for any unrecognized/invalid value — never assumes elevated permission", () => {
    expect(getRoleFromHeader("superadmin")).toBe("viewer");
    expect(getRoleFromHeader("")).toBe("viewer");
    expect(getRoleFromHeader("Administrator")).toBe("viewer"); // case-sensitive, no silent normalization
  });
});
