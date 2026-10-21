import { describe, it, expect } from "vitest";
import { applyZoneBase, sanitizeZoneBase, DEFAULT_ZONE_BASE_SETTING } from "@/lib/planning/zone-demand-settings";
import { DEFAULT_ZONE_CHECKIN_DEMAND_POLICY, zoneBaseAgents } from "@/lib/planning/checkin-zone-demand";

describe("T1 zone baseline setting", () => {
  it("defaults to Main 5, Italy/Spain 2, Domestic 2", () => {
    expect(DEFAULT_ZONE_BASE_SETTING).toEqual({ t1_main_checkin: 5, t1_italy_spain: 2, t1_domestic: 2 });
  });
  it("applyZoneBase overrides only base_agents and does not mutate the static default", () => {
    const p = applyZoneBase(DEFAULT_ZONE_BASE_SETTING);
    expect(zoneBaseAgents("t1_main_checkin", p)).toBe(5);
    expect(zoneBaseAgents("t1_domestic", p)).toBe(2);
    expect(p.zone_coefficients.t1_main_checkin?.dreamliner_extra_agents).toBe(1);
    expect(zoneBaseAgents("t1_main_checkin", DEFAULT_ZONE_CHECKIN_DEMAND_POLICY)).toBe(2);
  });
  it("sanitizes bad input: clamps to 1..20, rounds, falls back to defaults", () => {
    expect(sanitizeZoneBase({ t1_main_checkin: 99, t1_italy_spain: 0, t1_domestic: "x" })).toEqual({ t1_main_checkin: 20, t1_italy_spain: 1, t1_domestic: 2 });
    expect(sanitizeZoneBase(null)).toEqual(DEFAULT_ZONE_BASE_SETTING);
  });
});
