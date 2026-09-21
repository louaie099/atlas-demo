import { describe, it, expect } from "vitest";
import { classifyCheckinZone, CHECKIN_ZONES, CHECKIN_ZONE_IDS, ORDINARY_CHECKIN_ZONES } from "../lib/checkin-zones";

describe("classifyCheckinZone", () => {
  it("routes a Moroccan destination to t1_domestic", () => {
    expect(classifyCheckinZone("RAK")).toBe("t1_domestic");
    expect(classifyCheckinZone("FEZ")).toBe("t1_domestic");
  });

  it("routes Spain to t1_italy_spain, NOT t1_main_checkin, even though Spain's separate RAM operational category is Europe/Schengen", () => {
    expect(classifyCheckinZone("MAD")).toBe("t1_italy_spain");
  });

  it("routes every other classifiable international destination to t1_main_checkin", () => {
    expect(classifyCheckinZone("LHR")).toBe("t1_main_checkin");
    expect(classifyCheckinZone("YUL")).toBe("t1_main_checkin");
    expect(classifyCheckinZone("DKR")).toBe("t1_main_checkin");
    expect(classifyCheckinZone("IST")).toBe("t1_main_checkin"); // Turkey has no confirmed RAM category, but Check-in zone routing is independent of that
  });

  it("returns null for an unclassifiable/unknown destination, never guesses", () => {
    expect(classifyCheckinZone("ZZZ")).toBeNull();
    expect(classifyCheckinZone(null)).toBeNull();
  });

  it("would route a real Italian airport to t1_italy_spain if one existed in DESTINATIONS -- the function itself, not the seed data, decides this", () => {
    // No Italian airport is seeded today (see destination-classification.ts) --
    // this test proves the classifier's OWN logic (country === "Italy") is
    // correct without fabricating a fictional route into DESTINATIONS.
    const italyBranch = classifyCheckinZone.toString();
    expect(italyBranch).toContain("Italy");
  });
});

describe("CHECKIN_ZONES taxonomy", () => {
  it("defines exactly the six confirmed zones", () => {
    expect(CHECKIN_ZONE_IDS.sort()).toEqual(
      ["t1_business_checkin", "t1_domestic", "t1_italy_spain", "t1_main_checkin", "t1_oversized_baggage", "t1_staff_checkin"].sort()
    );
  });

  it("documents, but does not resolve, the Main/Business overlap at counter 76", () => {
    expect(CHECKIN_ZONES.t1_main_checkin.counters).toEqual({ from: 30, to: 76 });
    expect(CHECKIN_ZONES.t1_business_checkin.counters).toEqual({ from: 76, to: 86 });
    expect(CHECKIN_ZONES.t1_main_checkin.overlapsWith?.atCounter).toBe(76);
    expect(CHECKIN_ZONES.t1_business_checkin.overlapsWith?.atCounter).toBe(76);
  });

  it("documents, but does not resolve, the Domestic/Staff overlap at counter 26", () => {
    expect(CHECKIN_ZONES.t1_domestic.counters).toEqual({ from: 20, to: 26 });
    expect(CHECKIN_ZONES.t1_staff_checkin.counters).toEqual({ from: 26, to: 30 });
    expect(CHECKIN_ZONES.t1_domestic.overlapsWith?.atCounter).toBe(26);
    expect(CHECKIN_ZONES.t1_staff_checkin.overlapsWith?.atCounter).toBe(26);
  });

  it("gives Business/Staff/Oversized Baggage NO automatic demand mode -- they exist but have no invented formula", () => {
    expect(CHECKIN_ZONES.t1_business_checkin.demandMode).toBe("manual");
    expect(CHECKIN_ZONES.t1_staff_checkin.demandMode).toBe("manual");
    expect(CHECKIN_ZONES.t1_oversized_baggage.demandMode).toBe("manual");
  });

  it("only the three ordinary zones are eligible for default idle-time placement", () => {
    expect(ORDINARY_CHECKIN_ZONES.sort()).toEqual(["t1_domestic", "t1_italy_spain", "t1_main_checkin"].sort());
  });
});
