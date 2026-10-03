import { describe, it, expect } from "vitest";
import { deriveAutoFlightPhase, resolveFlightPhase, timeToMinutes } from "../lib/flight-phase";

// Fixed departure for every case below: 14:00 -> 840 minutes since midnight.
const DEPARTURE = "14:00";
const DEP_MIN = timeToMinutes(DEPARTURE);

function nowFor(minutesUntilDeparture: number): number {
  return DEP_MIN - minutesUntilDeparture;
}

describe("deriveAutoFlightPhase", () => {
  it("is pre_checkin well before check-in opens (> 240 min left)", () => {
    expect(deriveAutoFlightPhase(DEPARTURE, nowFor(300))).toBe("pre_checkin");
  });

  it("is checkin_open exactly at the 240-minute open threshold", () => {
    expect(deriveAutoFlightPhase(DEPARTURE, nowFor(240))).toBe("checkin_open");
  });

  it("is checkin_open just after the open threshold (mid check-in)", () => {
    expect(deriveAutoFlightPhase(DEPARTURE, nowFor(150))).toBe("checkin_open");
  });

  it("is checkin_closed exactly at the 60-minute close threshold", () => {
    expect(deriveAutoFlightPhase(DEPARTURE, nowFor(60))).toBe("checkin_closed");
  });

  it("is checkin_closed mid-gap, after close but before boarding starts", () => {
    expect(deriveAutoFlightPhase(DEPARTURE, nowFor(50))).toBe("checkin_closed");
  });

  it("is boarding exactly at the 45-minute boarding-start threshold", () => {
    expect(deriveAutoFlightPhase(DEPARTURE, nowFor(45))).toBe("boarding");
  });

  it("is boarding mid-boarding (between 45 and 15 minutes left)", () => {
    expect(deriveAutoFlightPhase(DEPARTURE, nowFor(30))).toBe("boarding");
  });

  it("is boarding_closing exactly at the 15-minute boarding-close threshold", () => {
    expect(deriveAutoFlightPhase(DEPARTURE, nowFor(15))).toBe("boarding_closing");
  });

  it("is departed exactly at departure time (0 minutes until departure)", () => {
    expect(deriveAutoFlightPhase(DEPARTURE, nowFor(0))).toBe("departed");
  });

  it("is departed after departure time has passed (negative minutes until departure)", () => {
    expect(deriveAutoFlightPhase(DEPARTURE, nowFor(-30))).toBe("departed");
  });
});

describe("resolveFlightPhase", () => {
  it("follows the clock when operational_phase_override is null", () => {
    const result = resolveFlightPhase({ operational_phase_override: null }, DEPARTURE, nowFor(30));
    expect(result).toEqual({ phase: "boarding", isManualOverride: false });
  });

  it("follows the clock when operational_phase_override is undefined", () => {
    const result = resolveFlightPhase({}, DEPARTURE, nowFor(300));
    expect(result).toEqual({ phase: "pre_checkin", isManualOverride: false });
  });

  it("a manual override always wins, regardless of what the clock would compute", () => {
    // Clock would say "pre_checkin" (300 minutes left), but the DO has
    // manually set boarding_closing -- the override must win outright.
    const result = resolveFlightPhase(
      { operational_phase_override: "boarding_closing" },
      DEPARTURE,
      nowFor(300)
    );
    expect(result).toEqual({ phase: "boarding_closing", isManualOverride: true });
  });

  it("a manual override of 'departed' wins even when the clock says the flight hasn't departed yet", () => {
    const result = resolveFlightPhase({ operational_phase_override: "departed" }, DEPARTURE, nowFor(200));
    expect(result).toEqual({ phase: "departed", isManualOverride: true });
  });
});
