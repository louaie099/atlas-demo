import { describe, it, expect } from "vitest";
import { classifyRamGateAndBoardingRequirements, missingOperationRuleRequirement } from "../lib/operation-rules";
import { classifyProfilingRequirement, classifyMesureRequirement } from "../lib/planning/specialized-demand";
import { classifyCompanyRequirement } from "../lib/company-config";
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
    booked_passengers: null, seat_capacity: null,
    ...overrides,
  };
}

describe("classifyRamGateAndBoardingRequirements", () => {
  it("returns Gate x1 + Boarding x1 for a standard aircraft to Europe/Schengen", () => {
    const reqs = classifyRamGateAndBoardingRequirements(makeFlight({}));
    expect(reqs).toHaveLength(2);
    expect(reqs?.find((r) => r.role === "Gate")?.total_requirement).toBe(1);
    expect(reqs?.find((r) => r.role === "Boarding")?.total_requirement).toBe(1);
    expect(reqs?.every((r) => r.needs_configuration === false)).toBe(true);
  });

  it("doubles both roles for a Dreamliner to the same category", () => {
    const reqs = classifyRamGateAndBoardingRequirements(
      makeFlight({ aircraft: "Boeing 787-9", destination_category: "Europe/Schengen" })
    );
    expect(reqs?.find((r) => r.role === "Gate")?.total_requirement).toBe(2);
    expect(reqs?.find((r) => r.role === "Boarding")?.total_requirement).toBe(2);
  });

  it("returns Gate x1 + Boarding x1 (no Profiling role here) for a standard aircraft to Africa", () => {
    const reqs = classifyRamGateAndBoardingRequirements(makeFlight({ destination_category: "Africa" }));
    expect(reqs?.find((r) => r.role === "Gate")?.total_requirement).toBe(1);
    expect(reqs?.find((r) => r.role === "Boarding")?.total_requirement).toBe(1);
  });

  it("returns null for an unconfigured destination category", () => {
    const reqs = classifyRamGateAndBoardingRequirements(
      makeFlight({ aircraft: "Airbus A320", destination_category: "Domestic" })
    );
    expect(reqs).toBeNull();
  });
});

describe("missingOperationRuleRequirement", () => {
  it("never fabricates a number — total_requirement is always 0 and needs_configuration is true", () => {
    const flight = makeFlight({ aircraft: "Airbus A320", destination_category: "Domestic" });
    const req = missingOperationRuleRequirement(flight);
    expect(req.total_requirement).toBe(0);
    expect(req.needs_configuration).toBe(true);
    expect(req.reasoning).toContain("No operation rule configured");
  });
});

describe("classifyProfilingRequirement", () => {
  it("returns a confirmed Profiling requirement for Europe/Schengen, matching the Gate/Boarding count", () => {
    const req = classifyProfilingRequirement(makeFlight({}));
    expect(req?.total_requirement).toBe(1);
    expect(req?.needs_configuration).toBe(false);
  });

  it("doubles for a Dreamliner", () => {
    const req = classifyProfilingRequirement(makeFlight({ aircraft: "Boeing 787-9" }));
    expect(req?.total_requirement).toBe(2);
  });

  it("returns null for Africa — Profiling does not apply there, this is not a gap", () => {
    const req = classifyProfilingRequirement(makeFlight({ destination_category: "Africa" }));
    expect(req).toBeNull();
  });

  it("returns a confirmed Profiling requirement for UK/USA too", () => {
    const req = classifyProfilingRequirement(makeFlight({ destination_category: "UK/USA" }));
    expect(req?.total_requirement).toBe(1);
    expect(req?.needs_configuration).toBe(false);
  });

  it("returns null when there's no established rule for the combination at all", () => {
    const req = classifyProfilingRequirement(makeFlight({ destination_category: "Domestic" }));
    expect(req).toBeNull();
  });
});

describe("classifyMesureRequirement", () => {
  it("UK/USA: confirmed Mesure headcount of 4, a real requirement — not needs_configuration any more", () => {
    const req = classifyMesureRequirement(makeFlight({ destination_category: "UK/USA" }));
    expect(req?.role).toBe("Mesure");
    expect(req?.total_requirement).toBe(4);
    expect(req?.needs_configuration).toBe(false);
  });

  it("Canada: same confirmed Mesure headcount of 4", () => {
    const req = classifyMesureRequirement(makeFlight({ destination_category: "Canada" }));
    expect(req?.total_requirement).toBe(4);
    expect(req?.needs_configuration).toBe(false);
  });

  it("Mesure headcount does NOT scale with aircraft class — Dreamliner to UK/USA is still 4, never 8", () => {
    const req = classifyMesureRequirement(makeFlight({ destination_category: "UK/USA", aircraft: "Boeing 787-9" }));
    expect(req?.total_requirement).toBe(4);
  });

  it("returns null for Europe/Schengen — Mesure does not apply there", () => {
    const req = classifyMesureRequirement(makeFlight({ destination_category: "Europe/Schengen" }));
    expect(req).toBeNull();
  });

  it("returns null for Africa — Mesure does not apply there", () => {
    const req = classifyMesureRequirement(makeFlight({ destination_category: "Africa" }));
    expect(req).toBeNull();
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

describe("classifyFlightRequirements — unconfigured foreign carrier", () => {
  it("produces NO requirement at all for an unconfigured carrier — the flight stays Flight-Schedule-only, never a fabricated needs_configuration row", () => {
    const flight = makeFlight({ airline: "Turkish Airlines", operator_type: "self_managed", destination_category: null });
    const req = classifyCompanyRequirement(flight);
    expect(req).toBeNull();
  });
});
