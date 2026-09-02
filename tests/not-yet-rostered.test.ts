import { describe, it, expect } from "vitest";
import { scoreCandidates } from "../lib/scoring";
import { detectConflict, recommendResolution } from "../lib/conflict";
import { CONFIG } from "../lib/seed-data";
import { Employee, Flight, PlannedDuty, ConflictInfo } from "../lib/types";

function makeUnrosteredEmployee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: "new-hire-1",
    name: "New Hire",
    skills: ["Boarding"],
    assignment: "General T1 Pool",
    shift_code: null,
    shift_start: null,
    shift_end: null,
    rest_before_shift_hours: null,
    weekly_hours: null,
    is_duty_officer: false,
    off_days: [],
    foreign_company_authorizations: [],
    active: true,
    weekly_shifts: [],
    ...overrides,
  };
}

describe("scoreCandidates — employees with no roster yet", () => {
  it("never appears as a candidate, recommended or flagged, when shift fields are null", () => {
    const employee = makeUnrosteredEmployee();
    const results = scoreCandidates("Boarding", { start: "13:50", end: "14:20" }, [employee], CONFIG);
    expect(results).toHaveLength(0);
  });

  it("becomes a normal candidate once a real shift is assigned (proving the exclusion is about missing data, not the employee itself)", () => {
    const employee = makeUnrosteredEmployee({
      shift_code: "AP01",
      shift_start: "13:45",
      shift_end: "22:45",
      rest_before_shift_hours: 12,
      weekly_hours: 10,
    });
    const results = scoreCandidates("Boarding", { start: "13:50", end: "14:20" }, [employee], CONFIG);
    expect(results.find((r) => r.employee.id === "new-hire-1")?.status).toBe("recommended");
  });
});

const ramFlight: Flight = {
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

describe("recommendResolution — employees with no roster yet", () => {
  it("never recommends an unrostered employee as a conflict resolution candidate", () => {
    const unrostered = makeUnrosteredEmployee({ id: "new-hire-2", skills: ["Care Point"] });
    const conflict: ConflictInfo = {
      employee: { ...unrostered, id: "someone-else" },
      flightId: "at201",
      plannedDuty: { id: "duty-1", employee_id: "someone-else", task: "Care Point rotation", planned_start: "14:30", status: "planned", reassigned_to_employee_id: null },
      overlapMinutes: 35,
    };
    const allPlannedDuties: PlannedDuty[] = [conflict.plannedDuty];
    const result = recommendResolution(conflict, [unrostered], allPlannedDuties, "Care Point");
    expect(result).toBeNull();
  });
});
