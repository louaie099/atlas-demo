import { describe, it, expect } from "vitest";
import { detectConflict, recommendResolution } from "../lib/conflict";
import { EMPLOYEES } from "../lib/seed-data";
import { Flight, PlannedDuty } from "../lib/types";

const delayedAT201: Flight = {
  id: "at201",
  flight_number: "AT201",
  airline: "Royal Air Maroc",
  route: "CMN → CDG",
  origin: "CMN",
  destination: "CDG",
  aircraft: "Boeing 737-800",
  equipment_code: null,
  registration: null,
  callsign: null,
  terminal: "T1",
  scheduled_departure: "15:15",
  scheduled_arrival: null,
  gate: "B12",
  boarding_window_start: "14:35",
  boarding_window_end: "15:05",
  status: "delayed",
  booking_pressure: "normal",
  day_of_week: "Wednesday",
  operator_type: "atlas_managed",
  destination_category: "Europe/Schengen",
};

const nadiaDuty: PlannedDuty = {
  id: "duty-nadia-carepoint",
  employee_id: "nadia-ziani",
  task: "Care Point rotation",
  planned_start: "14:30",
  status: "planned",
  reassigned_to_employee_id: null,
};

describe("detectConflict", () => {
  it("detects the Nadia Ziani / Care Point overlap after AT201 is delayed", () => {
    const nadia = EMPLOYEES.find((e) => e.id === "nadia-ziani")!;
    const conflict = detectConflict(delayedAT201, [nadia], [nadiaDuty]);
    expect(conflict).not.toBeNull();
    expect(conflict?.employee.id).toBe("nadia-ziani");
    expect(conflict?.overlapMinutes).toBe(35); // 15:05 - 14:30
  });

  it("finds no conflict when there is no overlapping planned duty", () => {
    const sara = EMPLOYEES.find((e) => e.id === "sara-bennis")!;
    const conflict = detectConflict(delayedAT201, [sara], [nadiaDuty]);
    expect(conflict).toBeNull();
  });
});

describe("recommendResolution", () => {
  it("recommends Amina Fassi to take over the Care Point rotation", () => {
    const nadia = EMPLOYEES.find((e) => e.id === "nadia-ziani")!;
    const conflict = detectConflict(delayedAT201, [nadia], [nadiaDuty])!;
    const resolution = recommendResolution(conflict, EMPLOYEES, [nadiaDuty], "Care Point");
    expect(resolution?.recommendedEmployee.id).toBe("amina-fassi");
  });
});
