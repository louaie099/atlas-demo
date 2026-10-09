import { describe, it, expect } from "vitest";
import { Employee, Flight, StaffingRequirement } from "../lib/types";
import { LiveOpsFlightView, LiveOpsRequirementView } from "../lib/live-ops-service";
import { acknowledgeAlert, activeAlerts, AlertSeverity, OperationalAlert, reconcileAlerts, sortAlertsForDisplay } from "../lib/live-ops-alerts";

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: "flight-at815",
    flight_number: "AT815",
    airline: "Royal Air Maroc",
    route: "CMN → CDG",
    origin: "CMN",
    destination: "CDG",
    aircraft: "Boeing 737",
    equipment_code: null,
    registration: null,
    callsign: null,
    terminal: "T1",
    scheduled_departure: "13:45",
    actual_departure: null,
    scheduled_arrival: null,
    gate: null,
    boarding_window_start: null,
    boarding_window_end: null,
    status: "scheduled",
    booking_pressure: "normal",
    day_of_week: "Monday",
    flight_date: "2026-10-12",
    week_start: "2026-10-12",
    operator_type: "atlas_managed",
    destination_category: null,
    booked_passengers: null,
    seat_capacity: null,
    ...overrides,
  };
}

function makeEmployee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: "emp-1",
    name: "Test Employee",
    skills: ["Gate", "Boarding"],
    assignment: "General",
    shift_code: "NR02",
    shift_start: "08:00",
    shift_end: "14:45",
    rest_before_shift_hours: 15,
    weekly_hours: 20,
    is_duty_officer: false,
    off_days: [],
    foreign_company_authorizations: [],
    active: true,
    weekly_shifts: [],
    ...overrides,
  };
}

function makeRequirement(overrides: Partial<StaffingRequirement> = {}): StaffingRequirement {
  return {
    id: "req-at815-gate",
    flight_id: "flight-at815",
    role: "Gate",
    baseline_requirement: 2,
    additional_requirement: 0,
    total_requirement: 2,
    source: "fixed_rule",
    reasoning: "",
    needs_configuration: false,
    ...overrides,
  };
}

function makeRequirementView(overrides: Partial<LiveOpsRequirementView> = {}): LiveOpsRequirementView {
  return {
    requirement: makeRequirement(),
    coverageLabel: "Gate",
    coverageStatus: "assigned",
    gap: 0,
    assignedEmployees: [],
    proposedEmployees: [],
    invalidatedAssignments: [],
    ...overrides,
  };
}

function makeView(overrides: Partial<LiveOpsFlightView> = {}): LiveOpsFlightView {
  const flight = overrides.flight ?? makeFlight();
  return {
    flight,
    effectiveDeparture: flight.scheduled_departure,
    requirements: [],
    ...overrides,
  };
}

describe("reconcileAlerts — detection", () => {
  it("generates no alert for a fully covered flight with no operational conflicts", () => {
    const view = makeView({ requirements: [makeRequirementView({ coverageStatus: "assigned", gap: 0 })] });
    const alerts = reconcileAlerts([], [view], null);
    expect(alerts).toHaveLength(0);
  });

  it("flags an ordinary never-staffed shortage as kind 'shortage'", () => {
    const view = makeView({
      requirements: [makeRequirementView({ coverageStatus: "gap", gap: 2, gapResolution: { eligible: true, candidates: [] } })],
    });
    const alerts = reconcileAlerts([], [view], null);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe("shortage");
    expect(alerts[0].state).toBe("new");
    expect(alerts[0].affectedCount).toBe(2);
  });

  it("flags a flight-change invalidation as kind 'invalidation', distinct from a plain shortage", () => {
    const employee = makeEmployee();
    const view = makeView({
      requirements: [
        makeRequirementView({
          coverageStatus: "conflict",
          gap: 1,
          invalidatedAssignments: [{ employee, oldWindow: { start: "12:45", end: "13:45" }, newWindow: { start: "17:45", end: "18:45" } }],
          gapResolution: { eligible: false, candidates: [], exclusionSummary: [{ reason: "No one else qualified is on shift", count: 3 }] },
        }),
      ],
    });
    const alerts = reconcileAlerts([], [view], null);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe("invalidation");
  });

  it("AT815 acceptance scenario: two Gate agents invalidated -> one alert reporting 0/2 valid, a gap of 2", () => {
    const e1 = makeEmployee({ id: "emp-1", name: "Agent One" });
    const e2 = makeEmployee({ id: "emp-2", name: "Agent Two" });
    const view = makeView({
      requirements: [
        makeRequirementView({
          coverageStatus: "conflict",
          gap: 2,
          assignedEmployees: [e1, e2],
          invalidatedAssignments: [
            { employee: e1, oldWindow: { start: "12:45", end: "13:45" }, newWindow: { start: "17:45", end: "18:45" } },
            { employee: e2, oldWindow: { start: "12:45", end: "13:45" }, newWindow: { start: "17:45", end: "18:45" } },
          ],
          gapResolution: { eligible: false, candidates: [], exclusionSummary: [] },
        }),
      ],
    });
    const alerts = reconcileAlerts([], [view], null);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].affectedCount).toBe(2);
    expect(alerts[0].detail).toContain("2 invalidated");
    expect(alerts[0].detail).toContain("gap of 2");
  });

  it("consolidates four simultaneous invalidated requirements on one flight into exactly one alert (never four)", () => {
    const e = makeEmployee();
    const invalidated = [{ employee: e, oldWindow: { start: "12:45", end: "13:45" }, newWindow: { start: "17:45", end: "18:45" } }];
    const view = makeView({
      requirements: [
        makeRequirementView({ requirement: makeRequirement({ id: "r-gate", role: "Gate" }), coverageStatus: "conflict", gap: 1, invalidatedAssignments: invalidated }),
        makeRequirementView({ requirement: makeRequirement({ id: "r-boarding", role: "Boarding" }), coverageStatus: "conflict", gap: 1, invalidatedAssignments: invalidated }),
        makeRequirementView({ requirement: makeRequirement({ id: "r-profiling", role: "Profiling" }), coverageStatus: "conflict", gap: 1, invalidatedAssignments: invalidated }),
        makeRequirementView({ requirement: makeRequirement({ id: "r-mesure", role: "Mesure" }), coverageStatus: "conflict", gap: 1, invalidatedAssignments: invalidated }),
      ],
    });
    const alerts = reconcileAlerts([], [view], null);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].requirementIds).toEqual(["r-gate", "r-boarding", "r-profiling", "r-mesure"]);
    expect(alerts[0].affectedCount).toBe(4);
  });

  it("escalates to critical when a flight with an unresolved shortage has entered its boarding window", () => {
    // AT815 scheduled 13:45; "now" = 13:05, 40 minutes out -> within the
    // boarding phase per lib/flight-phase.ts's own thresholds (45..15 min).
    const view = makeView({
      flight: makeFlight({ scheduled_departure: "13:45" }),
      requirements: [makeRequirementView({ coverageStatus: "gap", gap: 1, gapResolution: { eligible: false, candidates: [], exclusionSummary: [] } })],
    });
    const nowMinutes = 13 * 60 + 5;
    const alerts = reconcileAlerts([], [view], nowMinutes);
    expect(alerts[0].severity).toBe("critical");
  });

  it("is only 'info' for a resolvable shortage far from its operational window", () => {
    const view = makeView({
      flight: makeFlight({ scheduled_departure: "20:00" }),
      requirements: [makeRequirementView({ coverageStatus: "gap", gap: 1, gapResolution: { eligible: true, candidates: [] } })],
    });
    const nowMinutes = 8 * 60; // hours before departure
    const alerts = reconcileAlerts([], [view], nowMinutes);
    expect(alerts[0].severity).toBe("info");
  });
});

describe("reconcileAlerts — deduplication across repeated refreshes", () => {
  it("does not create a duplicate notification when the same problem persists across repeated refreshes", () => {
    const view = makeView({ requirements: [makeRequirementView({ coverageStatus: "gap", gap: 1, gapResolution: { eligible: true, candidates: [] } })] });
    const first = reconcileAlerts([], [view], null);
    const second = reconcileAlerts(first, [view], null);
    const third = reconcileAlerts(second, [view], null);
    expect(third).toHaveLength(1);
    expect(third[0].id).toBe(first[0].id);
  });

  it("updates the existing alert's content in place rather than minting a new one when the gap count changes", () => {
    const viewWithOneGap = makeView({ requirements: [makeRequirementView({ coverageStatus: "gap", gap: 1, gapResolution: { eligible: true, candidates: [] } })] });
    const viewWithTwoGaps = makeView({ requirements: [makeRequirementView({ coverageStatus: "gap", gap: 2, gapResolution: { eligible: true, candidates: [] } })] });
    const first = reconcileAlerts([], [viewWithOneGap], null);
    const second = reconcileAlerts(first, [viewWithTwoGaps], null);
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(first[0].id);
    expect(second[0].affectedCount).toBe(2);
  });
});

describe("acknowledgement vs resolution", () => {
  it("acknowledging an alert does not resolve the underlying operational problem", () => {
    const view = makeView({ requirements: [makeRequirementView({ coverageStatus: "gap", gap: 1, gapResolution: { eligible: true, candidates: [] } })] });
    const alerts = reconcileAlerts([], [view], null);
    const acknowledged = acknowledgeAlert(alerts, alerts[0].id);
    expect(acknowledged[0].state).toBe("acknowledged");

    // The problem is still present on the next refresh -- acknowledging
    // must never make it vanish from the active list.
    const next = reconcileAlerts(acknowledged, [view], null);
    expect(next[0].state).toBe("acknowledged");
    expect(activeAlerts(next)).toHaveLength(1);
  });

  it("a routine refresh never silently resets an acknowledged alert back to new", () => {
    const view = makeView({ requirements: [makeRequirementView({ coverageStatus: "gap", gap: 1, gapResolution: { eligible: true, candidates: [] } })] });
    const alerts = acknowledgeAlert(reconcileAlerts([], [view], null), reconcileAlerts([], [view], null)[0].id);
    for (let i = 0; i < 5; i++) {
      const next = reconcileAlerts(alerts, [view], null);
      expect(next[0].state).toBe("acknowledged");
    }
  });
});

describe("automatic resolution", () => {
  it("automatically resolves an alert once a confirmed replacement restores valid coverage", () => {
    const stillGap = makeView({ requirements: [makeRequirementView({ coverageStatus: "gap", gap: 1, gapResolution: { eligible: true, candidates: [] } })] });
    const covered = makeView({ requirements: [makeRequirementView({ coverageStatus: "assigned", gap: 0 })] });

    const open = reconcileAlerts([], [stillGap], null);
    expect(open[0].state).toBe("new");

    const resolved = reconcileAlerts(open, [covered], null);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].state).toBe("resolved");
    expect(resolved[0].resolvedAt).toBeDefined();
    expect(activeAlerts(resolved)).toHaveLength(0);
  });

  it("restores coverage after a delay reversal, resolving the alert the same way", () => {
    const delayed = makeView({
      flight: makeFlight({ actual_departure: "18:45" }),
      effectiveDeparture: "18:45",
      requirements: [
        makeRequirementView({
          coverageStatus: "conflict",
          gap: 1,
          invalidatedAssignments: [{ employee: makeEmployee(), oldWindow: { start: "12:45", end: "13:45" }, newWindow: { start: "17:45", end: "18:45" } }],
          gapResolution: { eligible: false, candidates: [], exclusionSummary: [] },
        }),
      ],
    });
    const reversed = makeView({
      flight: makeFlight({ actual_departure: null }),
      effectiveDeparture: "13:45",
      requirements: [makeRequirementView({ coverageStatus: "assigned", gap: 0 })],
    });

    const open = reconcileAlerts([], [delayed], null);
    expect(open[0].state).toBe("new");
    const resolved = reconcileAlerts(open, [reversed], null);
    expect(resolved[0].state).toBe("resolved");
  });

  it("an already-resolved alert is carried forward unchanged by further refreshes, not re-resolved repeatedly", () => {
    const stillGap = makeView({ requirements: [makeRequirementView({ coverageStatus: "gap", gap: 1, gapResolution: { eligible: true, candidates: [] } })] });
    const covered = makeView({ requirements: [makeRequirementView({ coverageStatus: "assigned", gap: 0 })] });
    const open = reconcileAlerts([], [stillGap], null);
    const resolvedOnce = reconcileAlerts(open, [covered], null);
    const resolvedAgain = reconcileAlerts(resolvedOnce, [covered], null);
    expect(resolvedAgain[0].resolvedAt).toBe(resolvedOnce[0].resolvedAt);
  });
});

describe("reappearance of a previously resolved problem", () => {
  it("reopens with the same alert id, state back to 'new', and a reopenedCount that records the history", () => {
    const gapView = makeView({ requirements: [makeRequirementView({ coverageStatus: "gap", gap: 1, gapResolution: { eligible: true, candidates: [] } })] });
    const coveredView = makeView({ requirements: [makeRequirementView({ coverageStatus: "assigned", gap: 0 })] });

    const open = reconcileAlerts([], [gapView], null);
    const resolved = reconcileAlerts(open, [coveredView], null);
    expect(resolved[0].state).toBe("resolved");

    const reopened = reconcileAlerts(resolved, [gapView], null);
    expect(reopened).toHaveLength(1);
    expect(reopened[0].id).toBe(resolved[0].id);
    expect(reopened[0].state).toBe("new");
    expect(reopened[0].reopenedCount).toBe(1);
  });
});

describe("click-through", () => {
  it("carries the flight id and every affected requirement id so a click can open and focus the right flight/requirement", () => {
    const view = makeView({
      requirements: [
        makeRequirementView({ requirement: makeRequirement({ id: "r-gate", role: "Gate" }), coverageStatus: "gap", gap: 1, gapResolution: { eligible: true, candidates: [] } }),
      ],
    });
    const alerts = reconcileAlerts([], [view], null);
    expect(alerts[0].flightId).toBe("flight-at815");
    expect(alerts[0].requirementIds).toContain("r-gate");
  });
});

function makeAlert(overrides: Partial<OperationalAlert> & { severity: AlertSeverity }): OperationalAlert {
  const now = Date.now();
  return {
    id: `alert-${overrides.severity}`,
    flightId: `flight-${overrides.severity}`,
    flightNumber: "AT999",
    destination: "CDG",
    kind: "shortage",
    state: "new",
    title: "",
    detail: "",
    requirementIds: [],
    affectedCount: 1,
    detectedAt: now,
    lastSeenAt: now,
    reopenedCount: 0,
    ...overrides,
  };
}

describe("sortAlertsForDisplay", () => {
  it("sorts critical before warning before info", () => {
    const alerts = [makeAlert({ severity: "info" }), makeAlert({ severity: "critical" }), makeAlert({ severity: "warning" })];
    const sorted = sortAlertsForDisplay(alerts);
    expect(sorted.map((a) => a.severity)).toEqual(["critical", "warning", "info"]);
  });
});
