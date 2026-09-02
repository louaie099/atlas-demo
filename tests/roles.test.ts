import { describe, it, expect } from "vitest";
import { canManageEmployees, getRoleFromHeader } from "../lib/roles";

describe("canManageEmployees", () => {
  it("only Administrator can manage employees", () => {
    expect(canManageEmployees("administrator")).toBe(true);
    expect(canManageEmployees("planner")).toBe(false);
    expect(canManageEmployees("viewer")).toBe(false);
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
