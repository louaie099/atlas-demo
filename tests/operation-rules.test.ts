import { describe, it, expect } from "vitest";
import { classifyRamBoardingRequirement, missingOperationRuleRequirement } from "../lib/operation-rules";
import { classifyCompanyRequirement, missingCompanyConfigRequirement } from "../lib/company-config";
import { Flight } from "../lib/types";

function makeFlight(overrides: Partial<Flight>): Flight {
  return {
    id: "test",
    flight_number: "TEST1",
    airline: "Royal Air Maroc",
    route: "CMN → XXX",
    origin: "CMN",
    destination: "XXX",
    aircraft: "Boeing 737-800",
    equipment_code: null,
    registration: null,
    callsign: null,
    terminal: "T1",
    scheduled_departure: "10:00",
    scheduled_arrival: null,
    gate: null,
    boarding_window_start: null,
    boarding_window_end: null,
    status: "scheduled",
    booking_pressure: "normal",
    day_of_week: "Wednesday",
    operator_type: "atlas_managed",
    destination_category: "Europe/Schengen",
    ...overrides,
  };
}

describe("classifyRamBoardingRequirement", () => {
  it("returns baseline 3 for Boeing 737-800 to Europe/Schengen (matches AT201)", () => {
    const req = classifyRamBoardingRequirement(makeFlight({}));
    expect(req?.baseline_requirement).toBe(3);
    expect(req?.source).toBe("fixed_rule");
    expect(req?.needs_configuration).toBe(false);
  });

  it("returns a different baseline for Boeing 787-9 Long-haul (matches AT880)", () => {
    const req = classifyRamBoardingRequirement(
      makeFlight({ aircraft: "Boeing 787-9", destination_category: "Long-haul" })
    );
    expect(req?.baseline_requirement).toBe(4);
  });

  it("returns null for an unconfigured aircraft/destination combination", () => {
    const req = classifyRamBoardingRequirement(
      makeFlight({ aircraft: "Airbus A320", destination_category: "Africa" })
    );
    expect(req).toBeNull();
  });
});

describe("missingOperationRuleRequirement", () => {
  it("never fabricates a number — total_requirement is always 0 and needs_configuration is true", () => {
    const flight = makeFlight({ aircraft: "Airbus A320", destination_category: "Africa" });
    const req = missingOperationRuleRequirement(flight);
    expect(req.total_requirement).toBe(0);
    expect(req.needs_configuration).toBe(true);
    expect(req.reasoning).toContain("No operation rule configured");
  });
});

describe("classifyCompanyRequirement", () => {
  it("returns the configured headcount for Qatar Airways (matches QR1013)", () => {
    const req = classifyCompanyRequirement(
      makeFlight({ airline: "Qatar Airways", operator_type: "self_managed", destination_category: null })
    );
    expect(req?.total_requirement).toBe(2);
    expect(req?.source).toBe("company_config");
  });

  it("returns null for a carrier with no configured agreement (matches TK651)", () => {
    const req = classifyCompanyRequirement(
      makeFlight({ airline: "Turkish Airlines", operator_type: "self_managed", destination_category: null })
    );
    expect(req).toBeNull();
  });
});

describe("missingCompanyConfigRequirement", () => {
  it("never fabricates a number for an unconfigured carrier", () => {
    const flight = makeFlight({ airline: "Turkish Airlines", operator_type: "self_managed", destination_category: null });
    const req = missingCompanyConfigRequirement(flight);
    expect(req.total_requirement).toBe(0);
    expect(req.needs_configuration).toBe(true);
  });
});
