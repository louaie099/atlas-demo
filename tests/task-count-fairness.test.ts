import { describe, it, expect } from "vitest";
import { scoreCandidates, TimeWindow } from "../lib/scoring";
import { DEFAULT_FAIRNESS_WEIGHTS } from "../lib/fairness-config";
import { CONFIG } from "../lib/seed-data";
import { Employee } from "../lib/types";

/**
 * Task-count fairness (2026-10-03 demo milestone — see
 * lib/fairness-config.ts's doc comment). Covers scoreCandidates' new
 * `tasksAssignedThisScope` tie-break, gated behind
 * `fairness_weights.taskCountWeight`, which now defaults to 1 (ON).
 *
 * All assertions here are about scoreCandidates' own ordering logic --
 * deliberately NOT a full roster-generation integration test (that would
 * be slow and would re-test duty-generation.ts's own, already-covered
 * eligibility/clustering behavior instead of this one new signal).
 */

const WINDOW: TimeWindow = { start: "13:50", end: "14:20" };

function rostered(id: string, overrides: Partial<Employee> = {}): Employee {
  return {
    id,
    name: id,
    skills: ["Boarding"],
    assignment: "General T1 Pool",
    shift_code: "NR01",
    shift_start: "08:00",
    shift_end: "17:00",
    rest_before_shift_hours: 24,
    weekly_hours: 10,
    is_duty_officer: false,
    off_days: [],
    foreign_company_authorizations: [],
    active: true,
    weekly_shifts: [{ day_of_week: "Wednesday", shift_code: "NR01", status: "working" }],
    ...overrides,
  };
}

describe("task-count fairness — scoreCandidates' taskCountWeight tie-break", () => {
  it("DEFAULT_FAIRNESS_WEIGHTS now enables taskCountWeight (confirmed demo behavior), unlike the still-unconfirmed workloadHoursWeight/fatigueWeight", () => {
    expect(DEFAULT_FAIRNESS_WEIGHTS.taskCountWeight).toBe(1);
    expect(DEFAULT_FAIRNESS_WEIGHTS.workloadHoursWeight).toBe(0);
    expect(DEFAULT_FAIRNESS_WEIGHTS.fatigueWeight).toBe(0);
  });

  it("with the new default (taskCountWeight: 1), among equally-eligible recommended candidates, fewer already-assigned comparable tasks ranks first", () => {
    const a = rostered("a");
    const b = rostered("b");
    const tasksAssignedThisScope = new Map([
      ["a", 3],
      ["b", 1],
    ]);
    const results = scoreCandidates("Boarding", WINDOW, [a, b], CONFIG, {}, undefined, new Map(), tasksAssignedThisScope);
    const recommended = results.filter((r) => r.status === "recommended");
    expect(recommended.map((r) => r.employee.id)).toEqual(["b", "a"]); // fewer tasks (b: 1) ranked first
  });

  it("never reorders a flagged candidate ahead of a recommended one, however lopsided the task counts", () => {
    // b is under-rested (flagged); a is fully recommended but has far more
    // already-assigned tasks. Task count must never override the hard
    // status gate.
    const a = rostered("a", { rest_before_shift_hours: 24 });
    const b = rostered("b", { rest_before_shift_hours: 4 }); // below CONFIG.minimum_rest_hours -> flagged
    const tasksAssignedThisScope = new Map([
      ["a", 10],
      ["b", 0],
    ]);
    const results = scoreCandidates("Boarding", WINDOW, [a, b], CONFIG, {}, undefined, new Map(), tasksAssignedThisScope);
    expect(results.map((r) => [r.employee.id, r.status])).toEqual([
      ["a", "recommended"],
      ["b", "flagged"],
    ]);
  });

  it("is a pure tie-breaker: a candidate requiring an unplanned shift extension is never preferred over a fully recommended one just for having fewer tasks", () => {
    const a = rostered("a", { shift_start: "08:00", shift_end: "17:00" }); // fully covers WINDOW
    const b = rostered("b", { shift_start: "08:00", shift_end: "14:00" }); // shift ends before WINDOW ends -> extension needed -> flagged
    const tasksAssignedThisScope = new Map([
      ["a", 5],
      ["b", 0],
    ]);
    const results = scoreCandidates("Boarding", WINDOW, [a, b], CONFIG, {}, undefined, new Map(), tasksAssignedThisScope);
    expect(results.map((r) => [r.employee.id, r.status])).toEqual([
      ["a", "recommended"],
      ["b", "flagged"],
    ]);
  });

  it("taskCountWeight: 0 reproduces the exact prior (pre-change) order — regression safety for old config_snapshots", () => {
    const a = rostered("a");
    const b = rostered("b");
    const tasksAssignedThisScope = new Map([
      ["a", 0],
      ["b", 9],
    ]);
    const configOff = { ...CONFIG, fairness_weights: { ...CONFIG.fairness_weights, taskCountWeight: 0 } };
    const results = scoreCandidates("Boarding", WINDOW, [a, b], configOff, {}, undefined, new Map(), tasksAssignedThisScope);
    // Weight off -> sort is a no-op for this key -> stable, input-pool order preserved.
    expect(results.map((r) => r.employee.id)).toEqual(["a", "b"]);

    // An old persisted config_snapshot (written before taskCountWeight
    // existed) has no key at all -- `?? 0` must treat that exactly the
    // same as an explicit 0.
    const legacySnapshotConfig = { ...CONFIG, fairness_weights: { workloadHoursWeight: 0 } };
    const legacyResults = scoreCandidates("Boarding", WINDOW, [a, b], legacySnapshotConfig, {}, undefined, new Map(), tasksAssignedThisScope);
    expect(legacyResults.map((r) => r.employee.id)).toEqual(["a", "b"]);
  });

  it("business's own example: 8 comparable requirements across 4 equally-eligible candidates land close to even (no 5/2/1/0-style skew)", () => {
    const agents = ["A", "B", "C", "D"].map((id) => rostered(id));
    const tasksAssignedThisScope = new Map<string, number>();
    const assignedCounts = new Map<string, number>();

    // Simulate 8 sequential comparable-task assignments: each time, ask
    // scoreCandidates who it prefers given the running tally, then "assign"
    // the top recommended candidate and update the tally -- exactly what
    // duty-generation.ts's self-balancing loop does within a single day.
    for (let i = 0; i < 8; i++) {
      const results = scoreCandidates("Boarding", WINDOW, agents, CONFIG, {}, undefined, new Map(), tasksAssignedThisScope);
      const winner = results.filter((r) => r.status === "recommended")[0].employee.id;
      assignedCounts.set(winner, (assignedCounts.get(winner) ?? 0) + 1);
      tasksAssignedThisScope.set(winner, (tasksAssignedThisScope.get(winner) ?? 0) + 1);
    }

    const counts = agents.map((e) => assignedCounts.get(e.id) ?? 0);
    expect(counts.reduce((sum, c) => sum + c, 0)).toBe(8);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1); // no agent at 0 while another is at 5+
    expect(counts).toEqual([2, 2, 2, 2]); // the business's own ideal distribution
  });
});
