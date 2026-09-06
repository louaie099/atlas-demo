import { describe, it, expect } from "vitest";
import { computeForeignCompanyProtectedWindow } from "../lib/foreign-company-window";
import { Flight } from "../lib/types";

function makeFlight(departure: string): Flight {
  return {
    id: "test",
    flight_number: "TEST1",
    airline: "Emirates",
    route: "CMN → DXB",
    origin: "CMN",
    destination: "DXB",
    aircraft: "Boeing 777-300ER",
    equipment_code: null,
    registration: null,
    callsign: null,
    terminal: "T2",
    scheduled_departure: departure,
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
  };
}

describe("computeForeignCompanyProtectedWindow", () => {
  it("computes a window starting 4h30 before departure", () => {
    const window = computeForeignCompanyProtectedWindow(makeFlight("15:50"));
    expect(window.start).toBe("11:20");
    expect(window.end).toBe("15:50");
  });

  it("handles a window that would cross midnight backward", () => {
    const window = computeForeignCompanyProtectedWindow(makeFlight("02:00"));
    expect(window.start).toBe("21:30"); // previous day, wrapped
    expect(window.end).toBe("02:00");
  });

  it("is generic — works identically regardless of airline (not hardcoded per carrier)", () => {
    const qatar = { ...makeFlight("17:20"), airline: "Qatar Airways" };
    const turkish = { ...makeFlight("17:20"), airline: "Turkish Airlines" };
    expect(computeForeignCompanyProtectedWindow(qatar)).toEqual(computeForeignCompanyProtectedWindow(turkish));
  });
});
