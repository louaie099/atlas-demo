import { describe, it, expect } from "vitest";
import { computeDefaultCheckinZonePlacement, subtractBusyWindows } from "../lib/planning/checkin-zone-placement";
import { Employee } from "../lib/types";

function makeEmployee(overrides: Partial<Employee>): Employee & { shift_start: string; shift_end: string } {
  return {
    id: "emp", name: "Test", skills: ["Check-in"], assignment: "General T1 Pool",
    shift_code: "AP01", shift_start: "05:45", shift_end: "14:45", rest_before_shift_hours: 15,
    weekly_hours: 10, is_duty_officer: false, off_days: [], foreign_company_authorizations: [],
    active: true, weekly_shifts: [{ day_of_week: "Wednesday", shift_code: "AP01", status: "working" }],
    ...overrides,
  } as Employee & { shift_start: string; shift_end: string };
}

describe("subtractBusyWindows", () => {
  it("splits a shift around a single middle commitment into two free intervals, never overlapping it", () => {
    const free = subtractBusyWindows({ start: "05:45", end: "14:45" }, [{ start: "08:00", end: "09:00" }]);
    expect(free).toEqual([
      { start: "05:45", end: "08:00" },
      { start: "09:00", end: "14:45" },
    ]);
  });

  it("drops a residual sliver shorter than the minimum placement duration", () => {
    const free = subtractBusyWindows({ start: "05:45", end: "06:00" }, []); // exactly 15 min -> below the 30 min minimum
    expect(free).toEqual([]);
  });

  it("returns the whole shift untouched when there are no busy windows", () => {
    const free = subtractBusyWindows({ start: "05:45", end: "14:45" }, []);
    expect(free).toEqual([{ start: "05:45", end: "14:45" }]);
  });

  it("returns nothing when a busy window fully covers the shift", () => {
    const free = subtractBusyWindows({ start: "05:45", end: "14:45" }, [{ start: "00:00", end: "23:59" }]);
    expect(free).toEqual([]);
  });
});

describe("computeDefaultCheckinZonePlacement", () => {
  it("places an eligible General T1 ACE with no other duty into a Check-in zone for their whole shift", () => {
    const employee = makeEmployee({ id: "e1" });
    const duties = computeDefaultCheckinZonePlacement("Wednesday", [employee], {}, {});
    expect(duties.length).toBe(1);
    expect(duties[0].employeeId).toBe("e1");
    expect(duties[0].window).toEqual({ start: "05:45", end: "14:45" });
    expect(duties[0].zone).toBe("t1_main_checkin"); // fallback default with no demand info
  });

  it("splits placement around an existing Gate/Boarding duty window, producing two non-overlapping placement duties", () => {
    const employee = makeEmployee({ id: "e1" });
    const busy = { e1: [{ start: "08:00", end: "09:00" }] };
    const duties = computeDefaultCheckinZonePlacement("Wednesday", [employee], busy, {});
    expect(duties.length).toBe(2);
    expect(duties.map((d) => d.window)).toEqual([
      { start: "05:45", end: "08:00" },
      { start: "09:00", end: "14:45" },
    ]);
  });

  it("never places a Transit-assigned employee, even if nominally Check-in-qualified", () => {
    const employee = makeEmployee({ id: "e1", assignment: "Transit", skills: ["Check-in", "Transit"] });
    const duties = computeDefaultCheckinZonePlacement("Wednesday", [employee], {}, {});
    expect(duties).toEqual([]);
  });

  it("never places a Profiling/Mesure-assigned employee -- that is their own team's real commitment", () => {
    const employee = makeEmployee({ id: "e1", assignment: "Profiling" });
    const duties = computeDefaultCheckinZonePlacement("Wednesday", [employee], {}, {});
    expect(duties).toEqual([]);
  });

  it("never places a fixed-planning-team employee (Leaders/Duty Officers/Caisse-BCB)", () => {
    const employee = makeEmployee({ id: "e1", assignment: "Leaders" });
    const duties = computeDefaultCheckinZonePlacement("Wednesday", [employee], {}, {});
    expect(duties).toEqual([]);
  });

  it("DOES place a foreign-company-assigned employee outside their protected window, now that redeployment defaults to true for every configured company (2026-09-22)", () => {
    // No busy window recorded here -- a real protected window would already
    // be part of `busy` (see the "protected foreign-company commitment
    // window" test above and the REDEPLOYMENT tests below), so this
    // exercises the eligibility gate itself: a Gulf Air-assigned, Check-in-
    // qualified, otherwise-idle employee is now a real placement candidate.
    const employee = makeEmployee({ id: "e1", assignment: "Gulf Air" });
    const duties = computeDefaultCheckinZonePlacement("Wednesday", [employee], {}, {});
    expect(duties.length).toBe(1);
    expect(duties[0].employeeId).toBe("e1");
  });

  it("still never places a foreign-company employee DURING their real protected window -- that window is recorded as busy before this stage ever runs", () => {
    const employee = makeEmployee({ id: "e1", assignment: "Gulf Air" });
    const busy = { e1: [{ start: "05:45", end: "10:15" }] }; // protected window covers the shift start
    const duties = computeDefaultCheckinZonePlacement("Wednesday", [employee], busy, {});
    expect(duties.length).toBe(1);
    expect(duties[0].window).toEqual({ start: "10:15", end: "14:45" }); // only the time AFTER the protected window is offered
  });

  it("never places an employee without the Check-in skill", () => {
    const employee = makeEmployee({ id: "e1", skills: ["Boarding"] });
    const duties = computeDefaultCheckinZonePlacement("Wednesday", [employee], {}, {});
    expect(duties).toEqual([]);
  });

  it("never places an inactive employee", () => {
    const employee = makeEmployee({ id: "e1", active: false });
    const duties = computeDefaultCheckinZonePlacement("Wednesday", [employee], {}, {});
    expect(duties).toEqual([]);
  });

  it("a protected foreign-company commitment window is treated as busy time and is never overlapped by a placement duty", () => {
    // Simulates a foreign-company ACE whose team IS opted into redeployment
    // (hypothetically) with a protected window already recorded as busy —
    // the placement duty must respect it exactly like any other busy window.
    const employee = makeEmployee({ id: "e1", assignment: "General T1 Pool" });
    const busy = { e1: [{ start: "10:15", end: "14:45" }] }; // protected window runs to shift end
    const duties = computeDefaultCheckinZonePlacement("Wednesday", [employee], busy, {});
    expect(duties.length).toBe(1);
    expect(duties[0].window).toEqual({ start: "05:45", end: "10:15" });
  });

  it("REQUIRED-STAYS-AT-DEMAND invariant: placement never changes based on how many eligible employees are free -- the demand engine (zone-demand-aggregation.ts) is entirely independent of this module's output", () => {
    // 4 eligible, idle employees -- the placement stage places all 4 (never
    // caps at some 'required' number), because placement and demand are
    // deliberately computed by two separate functions/modules that never
    // read each other's output as a ceiling.
    const employees = ["e1", "e2", "e3", "e4"].map((id) => makeEmployee({ id }));
    const duties = computeDefaultCheckinZonePlacement("Wednesday", employees, {}, {});
    expect(duties.length).toBe(4); // all 4 placed regardless of any zone's required_headcount elsewhere
  });
});
