import { describe, it, expect } from "vitest";
import { generateWeeklyFlights } from "../lib/flight-generator";
import { SCRIPTED_FLIGHTS } from "../lib/seed-data";

/**
 * Regression guard for a real data bug found 2026-10-04: AT650 (CMN -> IST)
 * was hand-typed with aircraft "Airbus A320" in lib/flight-generator.ts's
 * TEMPLATES, even though every other Royal Air Maroc flight in this
 * dataset correctly uses Boeing (737-800 / 787-9). Per the product
 * owner's own direct correction, RAM's real fleet is Boeing and Embraer
 * only -- it operates no Airbus aircraft at all. This asserts that fact
 * holds for every atlas_managed (RAM) flight this app generates, from
 * both the recurring weekly templates and the hand-authored scripted demo
 * flights (AT201/AT535), so a future template addition can't silently
 * reintroduce the same mistake. Self-managed (foreign carrier) flights
 * are explicitly NOT covered here -- several of those genuinely do fly
 * Airbus aircraft in reality (Qatar Airways, Etihad, Turkish Airlines,
 * Gulf Air, Air France), and that's correct, not a bug.
 */
describe("RAM (atlas_managed) fleet composition", () => {
  it("never assigns an Airbus aircraft to a generated weekly RAM flight", () => {
    const ramFlights = generateWeeklyFlights().filter((f) => f.operator_type === "atlas_managed");
    expect(ramFlights.length).toBeGreaterThan(0);
    for (const flight of ramFlights) {
      expect(flight.aircraft.toLowerCase()).not.toContain("airbus");
    }
  });

  it("never assigns an Airbus aircraft to a hand-authored scripted RAM flight", () => {
    const ramScripted = SCRIPTED_FLIGHTS.filter((f) => f.operator_type === "atlas_managed");
    expect(ramScripted.length).toBeGreaterThan(0);
    for (const flight of ramScripted) {
      expect(flight.aircraft.toLowerCase()).not.toContain("airbus");
    }
  });
});
