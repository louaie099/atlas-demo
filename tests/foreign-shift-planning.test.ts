import { describe, it, expect } from "vitest";
import { selectCompatibleShiftCode, findCompanyFlightsOnDay, planForeignCompanyDay } from "../lib/foreign-shift-planning";
import { Flight } from "../lib/types";

describe("selectCompatibleShiftCode", () => {
  it("selects MT02 for a Gulf-Air-style 09:00 departure (window 04:30-09:00), matching the stated example exactly", () => {
    expect(selectCompatibleShiftCode("04:30", "09:00")).toBe("MT02");
  });

  it("never invents a shift for a window no catalog code can cover", () => {
    expect(selectCompatibleShiftCode("01:00", "03:00")).toBeNull();
  });

  it("prefers the shift with the smallest start gap, then the shortest duration, when multiple are compatible", () => {
    // 11:20-15:50 (EK751-style): NR01 and NR02 both start at 08:00 (same
    // gap), but NR01 (08:00-16:45) is shorter than NR02 (08:00-18:15).
    expect(selectCompatibleShiftCode("11:20", "15:50")).toBe("NR01");
  });
});

function makeFlight(overrides: Partial<Flight>): Flight {
  return {
    id: "ek751-wednesday",
    flight_number: "EK751",
    airline: "Emirates",
    route: "CMN → DXB",
    origin: "CMN",
    destination: "DXB",
    aircraft: "Boeing 777-300ER",
    equipment_code: null,
    registration: null,
    callsign: null,
    terminal: "T2",
    scheduled_departure: "15:50",
    scheduled_arrival: null,
    gate: null,
    boarding_window_start: null,
    boarding_window_end: null,
    status: "scheduled",
    booking_pressure: "normal",
    day_of_week: "Wednesday",
    operator_type: "self_managed",
    destination_category: null,
    booked_passengers: null,
    seat_capacity: null,
    ...overrides,
  };
}

const emiratesFlightWed = makeFlight({});

describe("findCompanyFlightsOnDay", () => {
  it("finds the flight when the company operates that day", () => {
    expect(findCompanyFlightsOnDay("Emirates", "Wednesday", [emiratesFlightWed]).map((f) => f.id)).toEqual([
      "ek751-wednesday",
    ]);
  });

  it("returns an empty array, never a fabricated flight, when the company has no flight that day", () => {
    expect(findCompanyFlightsOnDay("Emirates", "Thursday", [emiratesFlightWed])).toEqual([]);
  });

  it("finds MULTIPLE same-company flights on one date — no assumption of at most one", () => {
    const secondFlight = makeFlight({ id: "ek752-wednesday", flight_number: "EK752", scheduled_departure: "20:00" });
    const found = findCompanyFlightsOnDay("Emirates", "Wednesday", [emiratesFlightWed, secondFlight]);
    expect(found).toHaveLength(2);
  });
});

describe("planForeignCompanyDay", () => {
  it("returns a full plan (flights, windows, combined window, shift) when the company flies that day", () => {
    const plan = planForeignCompanyDay("Emirates", "Wednesday", [emiratesFlightWed]);
    expect(plan).not.toBeNull();
    expect(plan?.shiftCode).toBe("NR01");
    expect(plan?.combinedWindow).toEqual({ start: "11:20", end: "15:50" });
    expect(plan?.windows).toHaveLength(1);
  });

  it("returns null when the company has no flight that day — the caller must not invent a commitment", () => {
    expect(planForeignCompanyDay("Emirates", "Sunday-with-no-flight", [emiratesFlightWed])).toBeNull();
  });

  it("combines the window across multiple same-day flights (earliest start to latest end) and selects one shift covering the whole span", () => {
    // Second Emirates flight the same day, departing later — the combined
    // window must span from the first flight's window start to the
    // second's window end, and the chosen shift must cover both.
    const secondFlight = makeFlight({ id: "ek752-wednesday", flight_number: "EK752", scheduled_departure: "20:00" });
    const plan = planForeignCompanyDay("Emirates", "Wednesday", [emiratesFlightWed, secondFlight]);
    expect(plan?.windows).toHaveLength(2);
    // Flight 1 window: 11:20-15:50. Flight 2 window: 15:30-20:00.
    expect(plan?.combinedWindow).toEqual({ start: "11:20", end: "20:00" });
  });
});
